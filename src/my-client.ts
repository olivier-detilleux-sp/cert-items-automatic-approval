import {
    Configuration,
    ConfigurationParameters,
    CertificationsApi,
    IAIRecommendationsApi,
    IdentitiesApi,
    IdentityHistoryApi,
    Paginator,
} from 'sailpoint-api-client'
import type {
    AccessReviewItem,
    IdentityCertificationDto,
    ReviewDecision,
} from 'sailpoint-api-client/dist/certifications/api'
import { CertificationDecision, DtoType } from 'sailpoint-api-client/dist/certifications/api'
import type { GetHistoricalIdentityEventsV1200ResponseInner } from 'sailpoint-api-client/dist/identity_history/api'
import type {
    RecommendationRequest,
    RecommendationResponse,
    RecommendationResponseDto,
    RecommendationResponseRecommendationEnum,
} from 'sailpoint-api-client/dist/iai_recommendations/api'
import { ConnectorError, logger } from '@sailpoint/connector-sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'

const DECISION_BATCH_SIZE = 50
const DEFAULT_AI_RECOMMENDATION_BATCH_SIZE = 50

const IDENTITY_CERTIFIED_EVENT_TYPE = 'IdentityCertified'
const ATTRIBUTES_CHANGED_EVENT_TYPE = 'AttributesChanged'

type AutoApprovalReason = 'IRREVOCABLE_ROLE' | 'PREVIOUSLY_APPROVED' | 'AI_RECOMMENDED'

type AccessKey = string

interface PreviousCertification {
    id: string
    signedAt: Date
    campaignName?: string
    source: 'ANNUAL' | 'MOBILITY_MINI'
    mobilityAt?: Date
}

interface PreviousApprovedAccess {
    certificationId: string
    signedAt: Date
    campaignName?: string
    source: 'ANNUAL' | 'MOBILITY_MINI'
    mobilityAt?: Date
    keys: Set<AccessKey>
}

/**
 * `eligible` is false when the certification exists but cannot feed the business rules (unknown
 * population, too old, mobility since). Its revocations still apply to AI approvals.
 */
interface PreviousCertificationLookup {
    certification: PreviousCertification
    eligible: boolean
}

interface PreviousCertificationDecisions {
    approved: Set<AccessKey>
    revoked: Set<AccessKey>
}

type Population = 'EMPLOYEE' | 'CONTRACTOR'

interface PopulationConfig {
    population: Population
    maxPreviousCertificationAgeMonths: number
    mobilityIdentityAttributes: Set<string>
}

interface ExecutionLog {
    timestamp: string
    level: string
    message: string
}

interface CandidateDecision {
    itemId: string
    identityId?: string
    accessId?: string
    accessType?: string
    decision: CertificationDecision
    comments: string
    reason: AutoApprovalReason
    previousSource?: 'ANNUAL' | 'MOBILITY_MINI'
}

interface PreApprovalTotals {
    itemsProcessed: number
    approvedFromPreviousCampaign: number
    approvedAsMandatory: number
    approvedFromMobilityMiniCampaign: number
    approvedFromAiRecommendation: number
}

interface FailedDecision {
    itemId: string
    identityId?: string
    reason: AutoApprovalReason
    error: string
}

interface CertificationResult {
    certificationId: string
    submitted: number
    failed: number
    items: CandidateDecision[]
    errors: FailedDecision[]
    skippedBecause?: string
}

interface MobilityChange {
    attribute: string
    previousValue?: string
    newValue?: string
    changedAt?: string
}

function accessKey(type?: string, id?: string): AccessKey | undefined {
    if (!type || !id) {
        return undefined
    }
    return `${type}:${id}`
}

/**
 * ISC does not always fill `accessSummary.access`: many items carry the id and the name only in the
 * type-specific sub-object (`entitlement`, `accessProfile`, `role`). Both sources are read so that those
 * items can still be matched against a previous campaign and sent to the recommendation engine.
 */
function getAccessRef(item: AccessReviewItem): { type?: string; id?: string; name?: string } {
    const summary = item.accessSummary
    const access = summary?.access
    const type =
        access?.type ??
        (summary?.entitlement
            ? DtoType.Entitlement
            : summary?.accessProfile
              ? DtoType.AccessProfile
              : summary?.role
                ? DtoType.Role
                : undefined)
    const details =
        type === DtoType.Entitlement
            ? summary?.entitlement
            : type === DtoType.AccessProfile
              ? summary?.accessProfile
              : type === DtoType.Role
                ? summary?.role
                : undefined

    return {
        type,
        id: access?.id ?? details?.id,
        name: access?.name ?? details?.name,
    }
}

function getAccessKey(item: AccessReviewItem): AccessKey | undefined {
    const access = getAccessRef(item)
    return accessKey(access.type, access.id)
}

function getIdentityId(item: AccessReviewItem): string | undefined {
    return item.identitySummary?.identityId
}

function getRecommendationKey(item: AccessReviewItem): string | undefined {
    const identityId = getIdentityId(item)
    const access = getAccessRef(item)
    if (!identityId || !access.type || !access.id) {
        return undefined
    }
    if (![DtoType.Entitlement, DtoType.AccessProfile, DtoType.Role].includes(access.type as any)) {
        return undefined
    }
    return `${identityId}|${access.type}:${access.id}`
}

function isIrrevocableRole(item: AccessReviewItem): boolean {
    return getAccessRef(item).type === DtoType.Role && item.accessSummary?.role?.revocable === false
}

function isPositiveDecision(decision?: string): boolean {
    return decision === CertificationDecision.Approve || decision === 'ACKNOWLEDGE'
}

function eventTimestamp(event: GetHistoricalIdentityEventsV1200ResponseInner): number {
    const date = event.signedDate ?? event.dateTime
    const timestamp = date ? Date.parse(date) : 0
    return Number.isFinite(timestamp) ? timestamp : 0
}

function describeItem(item: AccessReviewItem): string {
    const access = getAccessRef(item)
    return `item ${item.id} (${access.type ?? 'UNKNOWN_TYPE'} ${access.id ?? 'UNKNOWN_ID'} "${access.name ?? ''}")`
}

function subtractUtcMonths(date: Date, months: number): Date {
    const result = new Date(date)
    result.setUTCMonth(result.getUTCMonth() - months)
    return result
}

function formatFrenchDate(date: Date): string {
    const day = String(date.getUTCDate()).padStart(2, '0')
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    return `${day}/${month}/${date.getUTCFullYear()}`
}

function normalizeConfigValue(value: unknown): string {
    return String(value ?? '')
        .trim()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
}

function flattenAttributeValue(value: unknown): string[] {
    if (value === undefined || value === null) {
        return []
    }
    if (Array.isArray(value)) {
        return value.flatMap(flattenAttributeValue)
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
        return flattenAttributeValue((value as { value: unknown }).value)
    }
    const normalized = normalizeConfigValue(value)
    return normalized ? [normalized] : []
}

function readIdentityAttribute(
    attributes: Record<string, unknown>,
    attributeName: string
): { raw: unknown; values: string[] } {
    const exact = attributes[attributeName]
    if (exact !== undefined) {
        return { raw: exact, values: flattenAttributeValue(exact) }
    }

    const expected = attributeName.trim().toLowerCase()
    const match = Object.entries(attributes).find(([key]) => key.toLowerCase() === expected)
    return { raw: match?.[1], values: flattenAttributeValue(match?.[1]) }
}

function readBoolean(config: any, key: string, defaultValue = false): boolean {
    const value = config?.[key]
    if (value === undefined || value === null || value === '') {
        return defaultValue
    }
    if (typeof value === 'boolean') {
        return value
    }
    if (typeof value === 'number') {
        return value !== 0
    }
    const normalized = String(value).trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function readPositiveInteger(config: any, key: string): number {
    const value = Number(config?.[key])
    if (!Number.isInteger(value) || value <= 0) {
        throw new ConnectorError(`${key} must be a positive integer`)
    }
    return value
}

function readAttributeList(config: any, key: string): Set<string> {
    const value = config?.[key]
    if (value !== undefined && !Array.isArray(value)) {
        throw new ConnectorError(`${key} must be a list`)
    }
    return new Set(
        (value ?? [])
            .filter((attribute: unknown): attribute is string => typeof attribute === 'string')
            .map((attribute: string) => attribute.trim().toLowerCase())
            .filter(Boolean)
    )
}

function csvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`
}

const IRREVOCABLE_ROLE_COMMENT = 'Pré-validation par matrice: droits obligatoires'

/**
 * ISC rejects a whole decision batch when a single item is not allowed (self-certification for
 * instance), so the API payload is needed in the logs to understand which rule was hit.
 */
function describeApiError(error: unknown): string {
    const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string }
    const status = axiosError?.response?.status
    const data = axiosError?.response?.data
    const parts = [axiosError?.message ?? String(error)]

    if (status) {
        parts.unshift(`HTTP ${status}`)
    }
    if (data) {
        const details = typeof data === 'string' ? data : JSON.stringify(data)
        parts.push(details.length > 500 ? `${details.slice(0, 500)}...` : details)
    }

    return parts.join(' | ')
}

function chunk<T>(items: T[], size: number): T[][] {
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size))
    }
    return batches
}

export class MyClient {
    private configuration: Configuration
    private readonly debug: boolean
    private readonly enableAiRecommendations: boolean
    private readonly businessRulesOverrideAiNo: boolean
    private readonly approveAiRecommendedPreviouslyRevoked: boolean
    private readonly aiRecommendationBatchSize: number
    private readonly populationIdentityAttribute: string
    private readonly employeePopulationValues: Set<string>
    private readonly contractorPopulationValues: Set<string>
    private readonly employeeConfig: PopulationConfig
    private readonly contractorConfig: PopulationConfig
    private readonly certificationCampaignNameCache = new Map<string, string | undefined>()
    private readonly certificationItemsCache = new Map<string, AccessReviewItem[]>()
    private readonly identityHistoryEventsCache = new Map<
        string,
        GetHistoricalIdentityEventsV1200ResponseInner[]
    >()
    private executionLogs: ExecutionLog[] = []

    constructor(config: any) {
        const baseurl = typeof config?.baseurl === 'string' ? config.baseurl.trim() : ''
        const clientId = typeof config?.clientId === 'string' ? config.clientId.trim() : ''
        const clientSecret = typeof config?.clientSecret === 'string' ? config.clientSecret.trim() : ''

        if (!baseurl || !clientId || !clientSecret) {
            throw new ConnectorError('baseurl, clientId and clientSecret are required')
        }

        this.debug = readBoolean(config, 'debug', false)
        this.enableAiRecommendations = readBoolean(config, 'enableAiRecommendations', false)
        this.businessRulesOverrideAiNo = readBoolean(config, 'businessRulesOverrideAiNo', false)
        this.approveAiRecommendedPreviouslyRevoked = readBoolean(
            config,
            'approveAiRecommendedPreviouslyRevoked',
            false
        )
        this.aiRecommendationBatchSize =
            config?.aiRecommendationBatchSize === undefined
                ? DEFAULT_AI_RECOMMENDATION_BATCH_SIZE
                : readPositiveInteger(config, 'aiRecommendationBatchSize')

        this.populationIdentityAttribute =
            typeof config?.populationIdentityAttribute === 'string'
                ? config.populationIdentityAttribute.trim()
                : ''
        if (!this.populationIdentityAttribute) {
            throw new ConnectorError('populationIdentityAttribute is required')
        }
        this.employeePopulationValues = new Set(
            [...readAttributeList(config, 'employeePopulationValues')].map(normalizeConfigValue)
        )
        this.contractorPopulationValues = new Set(
            [...readAttributeList(config, 'contractorPopulationValues')].map(normalizeConfigValue)
        )
        if (this.employeePopulationValues.size === 0 || this.contractorPopulationValues.size === 0) {
            throw new ConnectorError(
                'employeePopulationValues and contractorPopulationValues must each contain at least one value'
            )
        }

        this.employeeConfig = {
            population: 'EMPLOYEE',
            maxPreviousCertificationAgeMonths: readPositiveInteger(
                config,
                'employeeMaxPreviousCertificationAgeMonths'
            ),
            mobilityIdentityAttributes: readAttributeList(
                config,
                'employeeMobilityIdentityAttributes'
            ),
        }
        this.contractorConfig = {
            population: 'CONTRACTOR',
            maxPreviousCertificationAgeMonths: readPositiveInteger(
                config,
                'contractorMaxPreviousCertificationAgeMonths'
            ),
            mobilityIdentityAttributes: readAttributeList(
                config,
                'contractorMobilityIdentityAttributes'
            ),
        }

        let tokenUrl: string
        try {
            tokenUrl = new URL('oauth/token', baseurl.endsWith('/') ? baseurl : `${baseurl}/`).toString()
        } catch {
            throw new ConnectorError('baseurl must be a valid URL')
        }

        const configurationParameters: ConfigurationParameters = {
            baseurl,
            clientId,
            clientSecret,
            tokenUrl,
        }

        if (config.accessToken) {
            configurationParameters.accessToken = config.accessToken
        }

        this.configuration = new Configuration(configurationParameters)
        // Mandatory: the SDK throws before sending any request carrying `X-SailPoint-Experimental`
        // (identity history, IAI recommendations) when this flag is not set.
        this.configuration.experimental = true
    }

    private getApi(): CertificationsApi {
        return new CertificationsApi(this.configuration)
    }

    private async getPopulationConfig(identityId: string): Promise<PopulationConfig | undefined> {
        const response = await new IdentitiesApi(this.configuration).getIdentityV1({ id: identityId })
        const attributes = (response.data.attributes ?? {}) as Record<string, unknown>
        const { raw, values } = readIdentityAttribute(attributes, this.populationIdentityAttribute)
        const displayedValue = values.length > 0 ? values.join(', ') : String(raw ?? '')

        if (values.some((value) => this.employeePopulationValues.has(value))) {
            this.trace(
                'info',
                `Identity ${identityId}: population EMPLOYEE from attribute ${this.populationIdentityAttribute}="${displayedValue}"`
            )
            return this.employeeConfig
        }
        if (values.some((value) => this.contractorPopulationValues.has(value))) {
            this.trace(
                'info',
                `Identity ${identityId}: population CONTRACTOR from attribute ${this.populationIdentityAttribute}="${displayedValue}"`
            )
            return this.contractorConfig
        }

        this.trace(
            'warn',
            `Identity ${identityId}: unsupported population "${displayedValue}" in attribute ${this.populationIdentityAttribute}; no history based pre-approval`
        )
        return undefined
    }

    private async getCertificationCampaignName(certificationId: string): Promise<string | undefined> {
        if (this.certificationCampaignNameCache.has(certificationId)) {
            return this.certificationCampaignNameCache.get(certificationId)
        }

        try {
            const response = await this.getApi().getIdentityCertificationV1({ id: certificationId })
            const campaignName = response.data.campaign?.name
            this.certificationCampaignNameCache.set(certificationId, campaignName)
            return campaignName
        } catch (error) {
            this.trace(
                'warn',
                `Certification ${certificationId}: campaign name could not be read, treating it as a regular certification: ${describeApiError(error)}`
            )
            this.certificationCampaignNameCache.set(certificationId, undefined)
            return undefined
        }
    }

    private trace(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
        if (!this.debug) {
            return
        }
        this.executionLogs.push({
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            message,
        })
        logger[level](message)
    }

    private writeExecutionLogCsv(campaignId: string): string | undefined {
        try {
            const directory = path.join(process.cwd(), 'logs')
            fs.mkdirSync(directory, { recursive: true })
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const filePath = path.join(directory, `campaign-pre-approve-${campaignId}-${stamp}.csv`)
            const rows = [
                ['timestamp', 'level', 'message'].map(csvCell).join(','),
                ...this.executionLogs.map((entry) =>
                    [entry.timestamp, entry.level, entry.message].map(csvCell).join(',')
                ),
            ]
            fs.writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8')
            logger.info(`Execution log CSV written to ${filePath}`)
            return filePath
        } catch (error) {
            logger.warn(`Could not write execution log CSV: ${describeApiError(error)}`)
            return undefined
        }
    }

    private async getCertificationByCampaignId(id: string): Promise<IdentityCertificationDto[]> {
        const apiInstance = this.getApi()
        const result = await Paginator.paginate(
            apiInstance,
            apiInstance.listIdentityCertificationsV1,
            {
                filters: 'campaign.id eq "' + id + '"',
            },
            250
        )

        return result.data ?? []
    }

    private async getCertificationItemsByCertificationId(id: string): Promise<AccessReviewItem[]> {
        const cached = this.certificationItemsCache.get(id)
        if (cached) {
            return cached
        }
        const apiInstance = this.getApi()
        const result = await Paginator.paginate(
            apiInstance,
            apiInstance.listIdentityAccessReviewItemsV1,
            { id: id },
            250
        )

        const items = result.data ?? []
        this.certificationItemsCache.set(id, items)
        return items
    }

    private async getCertificationItemsByCampaignId(campaignId: string): Promise<
        {
            certification: IdentityCertificationDto
            items: AccessReviewItem[]
        }[]
    > {
        const certifications = await this.getCertificationByCampaignId(campaignId)
        this.trace('info',`Campaign ${campaignId}: found ${certifications.length} certification(s)`)

        const results: { certification: IdentityCertificationDto; items: AccessReviewItem[] }[] = []

        for (const certification of certifications) {
            if (!certification?.id) {
                this.trace('warn',`Skipping certification without id for campaign ${campaignId}`)
                continue
            }

            this.trace('info',
                `Processing certification ${certification.id} "${certification.name ?? ''}" (reviewer ${certification.reviewer?.name ?? 'unknown'}, phase ${certification.phase ?? 'unknown'})`
            )

            try {
                const items = await this.getCertificationItemsByCertificationId(certification.id)
                const pendingItems = items.filter((item) => !item.completed).length
                this.trace('info',
                    `Certification ${certification.id}: ${items.length} item(s), ${pendingItems} still pending a decision`
                )
                results.push({ certification, items })
            } catch (error) {
                this.trace('error',
                    `Certification ${certification.id}: items could not be read, skipping it: ${describeApiError(error)}`
                )
            }
        }

        return results
    }

    private async getIdentityHistoryEvents(
        identityId: string
    ): Promise<GetHistoricalIdentityEventsV1200ResponseInner[]> {
        const cached = this.identityHistoryEventsCache.get(identityId)
        if (cached) {
            return cached
        }
        const apiInstance = new IdentityHistoryApi(this.configuration)
        const result = await Paginator.paginate(
            apiInstance,
            apiInstance.getHistoricalIdentityEventsV1,
            {
                id: identityId,
                eventTypes: [IDENTITY_CERTIFIED_EVENT_TYPE, ATTRIBUTES_CHANGED_EVENT_TYPE],
                xSailPointExperimental: 'true',
            },
            250
        )

        const events = result.data ?? []
        this.identityHistoryEventsCache.set(identityId, events)
        return events
    }

    /**
     * Collects the changes on configured mobility attributes that happened after `windowStart`.
     * Events without a usable date are kept on purpose so that a doubt never leads to a pre-approval.
     */
    private findMobilityChanges(
        identityId: string,
        events: GetHistoricalIdentityEventsV1200ResponseInner[],
        windowStart: Date,
        mobilityIdentityAttributes: Set<string>,
        windowEnd?: Date
    ): MobilityChange[] {
        const changes: MobilityChange[] = []

        for (const event of events) {
            if (event.eventType !== ATTRIBUTES_CHANGED_EVENT_TYPE) {
                continue
            }

            const timestamp = eventTimestamp(event)
            if (!timestamp) {
                this.trace('warn',
                    `Identity ${identityId}: ${ATTRIBUTES_CHANGED_EVENT_TYPE} event without date, considered inside the mobility window`
                )
            } else if (
                timestamp <= windowStart.getTime() ||
                (windowEnd && timestamp >= windowEnd.getTime())
            ) {
                continue
            }

            for (const change of event.attributeChanges ?? []) {
                const name = change.name?.trim()
                if (!name || !mobilityIdentityAttributes.has(name.toLowerCase())) {
                    continue
                }

                changes.push({
                    attribute: name,
                    previousValue: change.previousValue,
                    newValue: change.newValue,
                    changedAt: timestamp ? new Date(timestamp).toISOString() : undefined,
                })
            }
        }

        return changes
    }

    /**
     * Finds the identity's most recent previous certification, and tells whether it can feed the business
     * rules: it is discarded when the population is unknown, when it is too old, or when a configured
     * mobility attribute changed after it was signed. The history is read once per identity: a discarded
     * certification is still returned so that its revocations can guard AI approvals without a second search.
     */
    private async getPreviousCertificationForIdentity(
        identityId: string,
        excludedCertificationIds: Set<string>
    ): Promise<PreviousCertificationLookup | undefined> {
        const events = await this.getIdentityHistoryEvents(identityId)
        const certificationEvents = events.filter(
            (event) => event.eventType === IDENTITY_CERTIFIED_EVENT_TYPE
        )
        this.trace('info',
            `Identity ${identityId}: ${events.length} history event(s) retrieved (${certificationEvents.length} ${IDENTITY_CERTIFIED_EVENT_TYPE}, ${events.length - certificationEvents.length} ${ATTRIBUTES_CHANGED_EVENT_TYPE})`
        )

        const certificationEvent = certificationEvents
            .filter(
                (event) => event.certificationId && !excludedCertificationIds.has(event.certificationId)
            )
            .sort((a, b) => eventTimestamp(b) - eventTimestamp(a))[0]

        if (!certificationEvent) {
            this.trace('info',
                `Identity ${identityId}: no previous certification outside the current campaign, nothing can be pre-approved from history`
            )
            return undefined
        }

        const signedTimestamp = eventTimestamp(certificationEvent)
        if (!signedTimestamp) {
            this.trace('warn',
                `Identity ${identityId}: previous certification ${certificationEvent.certificationId} has no usable signed date, skipping history based pre-approval`
            )
            return undefined
        }

        const signedAt = new Date(signedTimestamp)
        const certification: PreviousCertification = {
            id: certificationEvent.certificationId as string,
            signedAt,
            source: 'ANNUAL',
        }

        const populationConfig = await this.getPopulationConfig(identityId)
        if (!populationConfig) {
            return { certification, eligible: false }
        }

        const oldestAllowedDate = subtractUtcMonths(
            new Date(),
            populationConfig.maxPreviousCertificationAgeMonths
        )

        if (signedAt < oldestAllowedDate) {
            this.trace('info',
                `Identity ${identityId} (${populationConfig.population}): previous certification ${certificationEvent.certificationId} signed at ${signedAt.toISOString()} is older than ${populationConfig.maxPreviousCertificationAgeMonths} month(s) (limit ${oldestAllowedDate.toISOString()}), access must be reviewed manually`
            )
            return { certification, eligible: false }
        }

        this.trace('info',
            `Identity ${identityId} (${populationConfig.population}): eligible previous certification ${certificationEvent.certificationId} signed at ${signedAt.toISOString()} (within ${populationConfig.maxPreviousCertificationAgeMonths} month(s))`
        )

        // The certification is guaranteed to be inside the age window, so it is the most restrictive
        // start for the mobility window.
        const mobilityWindowStart = signedAt > oldestAllowedDate ? signedAt : oldestAllowedDate
        const mobilityChanges = this.findMobilityChanges(
            identityId,
            events,
            mobilityWindowStart,
            populationConfig.mobilityIdentityAttributes
        )

        if (mobilityChanges.length > 0) {
            for (const change of mobilityChanges) {
                this.trace('info',
                    `Identity ${identityId}: mobility detected on attribute "${change.attribute}" at ${change.changedAt ?? 'unknown date'} ("${change.previousValue ?? ''}" -> "${change.newValue ?? ''}")`
                )
            }
            this.trace('info',
                `Identity ${identityId}: ${mobilityChanges.length} mobility change(s) since ${mobilityWindowStart.toISOString()}, certification ${certificationEvent.certificationId} is discarded and access must be reviewed manually`
            )
            return { certification, eligible: false }
        }

        this.trace('info',
            `Identity ${identityId}: no mobility on [${[...populationConfig.mobilityIdentityAttributes].join(', ') || 'none configured'}] since ${mobilityWindowStart.toISOString()}, certification ${certificationEvent.certificationId} is kept as reference`
        )

        const campaignName = await this.getCertificationCampaignName(certificationEvent.certificationId)
        const isMobilityMini = campaignName
            ?.trim()
            .toLowerCase()
            .startsWith('mini certification mobilité:')
        let mobilityAt: Date | undefined

        if (isMobilityMini) {
            const precedingMobility = this.findMobilityChanges(
                identityId,
                events,
                oldestAllowedDate,
                populationConfig.mobilityIdentityAttributes,
                signedAt
            ).sort((a, b) => {
                const left = a.changedAt ? Date.parse(a.changedAt) : 0
                const right = b.changedAt ? Date.parse(b.changedAt) : 0
                return right - left
            })[0]

            if (precedingMobility?.changedAt) {
                mobilityAt = new Date(precedingMobility.changedAt)
                this.trace(
                    'info',
                    `Identity ${identityId}: certification ${certificationEvent.certificationId} belongs to mobility mini-campaign "${campaignName}" and is linked by convention to the latest preceding mobility at ${mobilityAt.toISOString()}`
                )
            } else {
                this.trace(
                    'warn',
                    `Identity ${identityId}: certification ${certificationEvent.certificationId} belongs to mobility mini-campaign "${campaignName}", but no configured mobility event was found before it`
                )
            }
        }

        return {
            certification: {
                ...certification,
                campaignName,
                source: isMobilityMini ? 'MOBILITY_MINI' : 'ANNUAL',
                mobilityAt,
            },
            eligible: true,
        }
    }

    /**
     * A previous certification usually covers several identities of the current campaign, so its items are
     * fetched once and indexed by identity, with the approved and the revoked access of the same pass.
     */
    private async getDecisionsByIdentity(
        certificationId: string,
        cache: Map<string, Map<string, PreviousCertificationDecisions>>
    ): Promise<Map<string, PreviousCertificationDecisions>> {
        const cached = cache.get(certificationId)
        if (cached) {
            return cached
        }

        const items = await this.getCertificationItemsByCertificationId(certificationId)
        const decisionsByIdentity = new Map<string, PreviousCertificationDecisions>()

        for (const item of items) {
            const identityId = getIdentityId(item)
            const key = getAccessKey(item)
            if (!identityId || !key) {
                continue
            }

            const decisions =
                decisionsByIdentity.get(identityId) ??
                { approved: new Set<AccessKey>(), revoked: new Set<AccessKey>() }
            if (isPositiveDecision(item.decision)) {
                decisions.approved.add(key)
            } else if (item.decision === 'REVOKE') {
                decisions.revoked.add(key)
            }
            decisionsByIdentity.set(identityId, decisions)
        }

        cache.set(certificationId, decisionsByIdentity)
        return decisionsByIdentity
    }

    /**
     * Single history lookup per identity. The most recent certification outside the current campaign gives
     * both the access that can be pre-approved by the business rule and the access it revoked, which guards
     * AI approvals. When the identity has no previous certification, nothing else is searched.
     */
    private async getPreviousCertificationDecisionsByIdentity(
        identityIds: Set<string>,
        currentCertificationIds: Set<string>
    ): Promise<{
        approved: Map<string, PreviousApprovedAccess>
        revoked: Map<string, Set<AccessKey>>
    }> {
        const approved = new Map<string, PreviousApprovedAccess>()
        const revoked = new Map<string, Set<AccessKey>>()
        const decisionsCache = new Map<string, Map<string, PreviousCertificationDecisions>>()

        for (const identityId of identityIds) {
            try {
                const lookup = await this.getPreviousCertificationForIdentity(
                    identityId,
                    currentCertificationIds
                )

                if (!lookup) {
                    continue
                }

                const decisionsByIdentity = await this.getDecisionsByIdentity(
                    lookup.certification.id,
                    decisionsCache
                )
                const decisions = decisionsByIdentity.get(identityId)
                revoked.set(identityId, decisions?.revoked ?? new Set<AccessKey>())

                if (!lookup.eligible) {
                    continue
                }

                const approvedKeys = decisions?.approved ?? new Set<AccessKey>()
                approved.set(identityId, {
                    certificationId: lookup.certification.id,
                    signedAt: lookup.certification.signedAt,
                    campaignName: lookup.certification.campaignName,
                    source: lookup.certification.source,
                    mobilityAt: lookup.certification.mobilityAt,
                    keys: approvedKeys,
                })

                this.trace('info',
                    `Identity ${identityId}: ${approvedKeys.size} access previously approved in certification ${lookup.certification.id} are eligible for pre-approval`
                )
            } catch (error) {
                this.trace('error',
                    `Identity ${identityId}: previous certification could not be read, no history based pre-approval and no AI approval for it: ${describeApiError(error)}`
                )
                // The sentinel prevents AI approval when previous decisions could not be verified.
                revoked.set(identityId, new Set(['*']))
            }
        }

        return { approved, revoked }
    }

    private async getAiRecommendations(
        items: AccessReviewItem[]
    ): Promise<Map<string, RecommendationResponseRecommendationEnum>> {
        const recommendations = new Map<string, RecommendationResponseRecommendationEnum>()
        if (!this.enableAiRecommendations) {
            return recommendations
        }

        const requestsByKey = new Map<string, RecommendationRequest>()
        let unsupportedItems = 0
        let firstUnsupportedItem: AccessReviewItem | undefined
        for (const item of items) {
            if (!item.id || item.completed) {
                continue
            }
            const key = getRecommendationKey(item)
            const identityId = getIdentityId(item)
            const access = getAccessRef(item)
            if (!key || !identityId || !access.id || !access.type) {
                unsupportedItems++
                firstUnsupportedItem = firstUnsupportedItem ?? item
                continue
            }
            requestsByKey.set(key, {
                identityId,
                item: {
                    id: access.id,
                    type: access.type as RecommendationRequest['item'] extends { type?: infer T }
                        ? T
                        : never,
                },
            })
        }

        const entries = [...requestsByKey.entries()]
        const batches = chunk(entries, this.aiRecommendationBatchSize)
        this.trace('info',
            `AI recommendations: ${entries.length} unique identity/access pair(s) to score in ${batches.length} batch(es) of up to ${this.aiRecommendationBatchSize}, ${unsupportedItems} pending item(s) ignored because no supported access type and id could be read`
        )
        if (firstUnsupportedItem) {
            this.trace('warn',
                `AI recommendations: ${describeItem(firstUnsupportedItem)} has no usable access reference, its accessSummary starts with ${JSON.stringify(firstUnsupportedItem.accessSummary).slice(0, 500)}`
            )
        }

        const api = new IAIRecommendationsApi(this.configuration)
        let batchNumber = 0
        for (const batch of batches) {
            batchNumber++
            try {
                const response = await api.getRecommendationsV1({
                    recommendationRequestDto: {
                        requests: batch.map(([, request]) => request),
                        excludeInterpretations: true,
                        includeTranslationMessages: false,
                        includeDebugInformation: false,
                        prescribeMode: false,
                    },
                    xSailPointExperimental: 'true',
                })

                // ISC answers with `responses`, while the SDK type declares `response`. Both are read so
                // the connector keeps working whichever field the tenant returns.
                const payload = response.data as RecommendationResponseDto & {
                    responses?: RecommendationResponse[]
                }
                const results = payload.response ?? payload.responses ?? []
                // The API is expected to echo each request, but pairing by index keeps the mapping usable
                // when the echo is missing, as long as the response has one entry per request sent.
                const canPairByIndex = results.length === batch.length
                let mapped = 0

                results.forEach((result, index) => {
                    if (!result.recommendation) {
                        return
                    }
                    const echoed = result.request
                    const echoedKey =
                        echoed?.identityId && echoed.item?.type && echoed.item.id
                            ? `${echoed.identityId}|${echoed.item.type}:${echoed.item.id}`
                            : undefined
                    const key =
                        echoedKey && requestsByKey.has(echoedKey)
                            ? echoedKey
                            : canPairByIndex
                              ? batch[index][0]
                              : undefined
                    if (!key) {
                        return
                    }
                    recommendations.set(key, result.recommendation)
                    mapped++
                })

                this.trace('info',
                    `AI recommendations: batch ${batchNumber}/${batches.length} sent ${batch.length} request(s), received ${results.length} response(s) and mapped ${mapped} recommendation(s)`
                )
                if (mapped === 0) {
                    this.trace('warn',
                        `AI recommendations: batch ${batchNumber}/${batches.length} returned no usable recommendation, response payload starts with ${JSON.stringify(response.data).slice(0, 500)}`
                    )
                }
            } catch (error) {
                this.trace('warn',
                    `AI recommendations: batch ${batchNumber}/${batches.length} failed; its items will follow business rules because no recommendation is available: ${describeApiError(error)}`
                )
            }
        }

        const distribution = new Map<string, number>()
        for (const recommendation of recommendations.values()) {
            distribution.set(recommendation, (distribution.get(recommendation) ?? 0) + 1)
        }
        const summary =
            [...distribution.entries()].map(([value, count]) => `${count} ${value}`).join(', ') ||
            'none'
        this.trace('info',
            `AI recommendations: ${recommendations.size} recommendation(s) available out of ${entries.length} requested (${summary})`
        )
        if (entries.length > 0 && recommendations.size === 0) {
            // Visible without debug: the AI filtering is enabled but has no effect at all.
            logger.warn(
                `AI recommendations are enabled but none of the ${entries.length} requested identity/access pair(s) got a recommendation; check that the recommendations service is active on the tenant and that the token can call it`
            )
        }

        return recommendations
    }

    private evaluateItems(
        certificationId: string,
        items: AccessReviewItem[],
        previousApprovedAccess: Map<string, PreviousApprovedAccess>,
        recommendations: Map<string, RecommendationResponseRecommendationEnum> = new Map(),
        previouslyRevokedAccess: Map<string, Set<AccessKey>> = new Map()
    ): CandidateDecision[] {
        const candidates: CandidateDecision[] = []

        for (const item of items) {
            if (!item.id || item.completed) {
                continue
            }

            let businessCandidate: CandidateDecision | undefined
            if (isIrrevocableRole(item)) {
                this.trace(
                    'info',
                    `Certification ${certificationId}: acknowledging ${describeItem(item)} for identity ${getIdentityId(item) ?? 'unknown'} because the role is not revocable`
                )
                businessCandidate = {
                    itemId: item.id,
                    identityId: getIdentityId(item),
                    accessId: getAccessRef(item).id,
                    accessType: getAccessRef(item).type,
                    decision: CertificationDecision.Approve,
                    comments: IRREVOCABLE_ROLE_COMMENT,
                    reason: 'IRREVOCABLE_ROLE',
                }
            } else if (item.newAccess === false) {
                const identityId = getIdentityId(item)
                const key = getAccessKey(item)
                if (identityId && key) {
                    const previouslyApproved = previousApprovedAccess.get(identityId)
                    if (previouslyApproved?.keys.has(key)) {
                        this.trace(
                            'info',
                            `Certification ${certificationId}: pre-approving ${describeItem(item)} for identity ${identityId} because the same access was already approved in the last eligible certification`
                        )
                        businessCandidate = {
                            itemId: item.id,
                            identityId,
                            accessId: getAccessRef(item).id,
                            accessType: getAccessRef(item).type,
                            decision: CertificationDecision.Approve,
                            comments:
                                previouslyApproved.source === 'MOBILITY_MINI'
                                    ? previouslyApproved.mobilityAt
                                        ? `Pré-validation car déjà approuvé lors de la mini certification liée à la mobilité du ${formatFrenchDate(previouslyApproved.mobilityAt)}`
                                        : `Pré-validation car déjà approuvé lors de la mini certification de mobilité en date du ${formatFrenchDate(previouslyApproved.signedAt)}`
                                    : `Pré-validation à partir d'une campagne de recertification précédente en date du ${formatFrenchDate(previouslyApproved.signedAt)}`,
                            reason: 'PREVIOUSLY_APPROVED',
                            previousSource: previouslyApproved.source,
                        }
                    }
                }
            }

            const recommendationKey = getRecommendationKey(item)
            const recommendation = recommendationKey
                ? recommendations.get(recommendationKey)
                : undefined

            if (recommendation === 'NO') {
                if (this.businessRulesOverrideAiNo && businessCandidate) {
                    this.trace(
                        'info',
                        `Certification ${certificationId}: applying the business rule for ${describeItem(item)} despite AI recommendation NO because businessRulesOverrideAiNo is enabled`
                    )
                } else {
                    this.trace(
                        'info',
                        `Certification ${certificationId}: leaving ${describeItem(item)} to the reviewer because the ISC AI engine returned recommendation NO`
                    )
                    continue
                }
            }

            // Business rules keep their reason and comment when AI says YES or has no opinion.
            if (businessCandidate) {
                candidates.push(businessCandidate)
                continue
            }

            if (recommendation !== 'YES') {
                this.trace(
                    'info',
                    `Certification ${certificationId}: leaving ${describeItem(item)} to the reviewer because no business rule applies and AI recommendation is ${recommendation ?? 'not available'}`
                )
                continue
            }

            const identityId = getIdentityId(item)
            const key = getAccessKey(item)
            if (!identityId || !key) {
                continue
            }
            const revoked = previouslyRevokedAccess.get(identityId)
            const wasPreviouslyRevoked = revoked?.has('*') || revoked?.has(key)
            if (wasPreviouslyRevoked && !this.approveAiRecommendedPreviouslyRevoked) {
                this.trace(
                    'info',
                    `Certification ${certificationId}: leaving ${describeItem(item)} to the reviewer despite AI recommendation YES because it was revoked in the last signed certification`
                )
                continue
            }

            candidates.push({
                itemId: item.id,
                identityId,
                accessId: getAccessRef(item).id,
                accessType: getAccessRef(item).type,
                decision: CertificationDecision.Approve,
                comments: wasPreviouslyRevoked
                    ? 'Pré-validation automatique par le moteur de recommandation AI de SailPoint malgré une révocation lors de la précédente certification'
                    : 'Pré-validation automatique car accès recommandé par le moteur AI de SailPoint',
                reason: 'AI_RECOMMENDED',
            })
            this.trace(
                'info',
                `Certification ${certificationId}: pre-approving ${describeItem(item)} for identity ${identityId} because the ISC AI engine returned recommendation YES`
            )
        }

        return candidates
    }

    /**
     * A rejected batch is replayed one decision at a time: a single forbidden item (self-certification,
     * reassigned item, item already decided) must not discard the other valid decisions.
     */
    private async submitDecisions(
        certificationId: string,
        candidates: CandidateDecision[]
    ): Promise<{ submitted: CandidateDecision[]; failed: FailedDecision[] }> {
        const api = this.getApi()
        const batches = chunk(candidates, DECISION_BATCH_SIZE)
        const submitted: CandidateDecision[] = []
        const failed: FailedDecision[] = []
        let batchNumber = 0

        const toReviewDecisions = (entries: CandidateDecision[]): ReviewDecision[] =>
            entries.map((candidate) => ({
                id: candidate.itemId,
                decision: candidate.decision,
                bulk: true,
                comments: candidate.comments,
            }))

        for (const batch of batches) {
            batchNumber += 1
            this.trace('info',
                `Certification ${certificationId}: submitting batch ${batchNumber}/${batches.length} with ${batch.length} decision(s)`
            )

            try {
                await api.makeIdentityDecisionV1({
                    id: certificationId,
                    reviewDecision: toReviewDecisions(batch),
                })
                submitted.push(...batch)
                continue
            } catch (error) {
                this.trace('warn',
                    `Certification ${certificationId}: batch ${batchNumber}/${batches.length} rejected (${describeApiError(error)}), replaying its ${batch.length} decision(s) one by one`
                )
            }

            for (const candidate of batch) {
                try {
                    await api.makeIdentityDecisionV1({
                        id: certificationId,
                        reviewDecision: toReviewDecisions([candidate]),
                    })
                    submitted.push(candidate)
                } catch (error) {
                    const description = describeApiError(error)
                    this.trace('error',
                        `Certification ${certificationId}: decision refused for item ${candidate.itemId} (identity ${candidate.identityId ?? 'unknown'}, ${candidate.accessType ?? 'UNKNOWN_TYPE'} ${candidate.accessId ?? 'UNKNOWN_ID'}, reason ${candidate.reason}): ${description}`
                    )
                    failed.push({
                        itemId: candidate.itemId,
                        identityId: candidate.identityId,
                        reason: candidate.reason,
                        error: description,
                    })
                }
            }
        }

        return { submitted, failed }
    }

    async autoApproveCertificationItemsByCampaignId(campaignId: string): Promise<{
        campaignId: string
        totals: PreApprovalTotals
        submitted?: number
        failed?: number
        loggedEvents?: number
        logCsvPath?: string
        certifications?: CertificationResult[]
    }> {
        this.executionLogs = []
        this.certificationItemsCache.clear()
        this.identityHistoryEventsCache.clear()
        this.trace('info',
            `Starting pre-approval for campaign ${campaignId} (debug=${this.debug}, enableAiRecommendations=${this.enableAiRecommendations}, businessRulesOverrideAiNo=${this.businessRulesOverrideAiNo}, approveAiRecommendedPreviouslyRevoked=${this.approveAiRecommendedPreviouslyRevoked}, aiRecommendationBatchSize=${this.aiRecommendationBatchSize}, populationIdentityAttribute=${this.populationIdentityAttribute}, employeeValues=[${[...this.employeePopulationValues].join(', ')}], employeeMaxAgeMonths=${this.employeeConfig.maxPreviousCertificationAgeMonths}, employeeMobilityAttributes=[${[...this.employeeConfig.mobilityIdentityAttributes].join(', ') || 'none'}], contractorValues=[${[...this.contractorPopulationValues].join(', ')}], contractorMaxAgeMonths=${this.contractorConfig.maxPreviousCertificationAgeMonths}, contractorMobilityAttributes=[${[...this.contractorConfig.mobilityIdentityAttributes].join(', ') || 'none'}])`
        )

        const certificationsWithItems = await this.getCertificationItemsByCampaignId(campaignId)

        const currentCertificationIds = new Set<string>()
        const recertifiedIdentityIds = new Set<string>()
        const allItems: AccessReviewItem[] = []
        for (const { certification, items } of certificationsWithItems) {
            if (certification.id) {
                currentCertificationIds.add(certification.id)
            }
            for (const item of items) {
                allItems.push(item)
                if (item.completed || isIrrevocableRole(item) || item.newAccess !== false) {
                    continue
                }
                const identityId = getIdentityId(item)
                if (identityId) {
                    recertifiedIdentityIds.add(identityId)
                }
            }
        }

        this.trace('info',
            `Campaign ${campaignId}: ${recertifiedIdentityIds.size} identity(ies) with re-certified access to check against their history`
        )

        const { approved: previousApprovedAccess, revoked: previouslyRevokedAccess } =
            await this.getPreviousCertificationDecisionsByIdentity(
                recertifiedIdentityIds,
                currentCertificationIds
            )
        const recommendations = await this.getAiRecommendations(allItems)

        const certifications: CertificationResult[] = []
        let itemsProcessed = 0
        const submittedDecisions: CandidateDecision[] = []

        for (const { certification, items } of certificationsWithItems) {
            if (!certification.id) {
                continue
            }

            itemsProcessed += items.filter((item) => Boolean(item.id) && !item.completed).length

            try {
                const candidates = this.evaluateItems(
                    certification.id,
                    items,
                    previousApprovedAccess,
                    recommendations,
                    previouslyRevokedAccess
                )
                const irrevocableRoles = candidates.filter(
                    (candidate) => candidate.reason === 'IRREVOCABLE_ROLE'
                ).length
                const previouslyApproved = candidates.filter(
                    (candidate) => candidate.reason === 'PREVIOUSLY_APPROVED'
                ).length
                const aiRecommended = candidates.filter(
                    (candidate) => candidate.reason === 'AI_RECOMMENDED'
                ).length

                if (candidates.length === 0) {
                    this.trace('info',`Certification ${certification.id}: no item matches the auto-approval criteria`)
                    certifications.push({
                        certificationId: certification.id,
                        submitted: 0,
                        failed: 0,
                        items: [],
                        errors: [],
                    })
                    continue
                }

                this.trace('info',
                    `Certification ${certification.id}: ${candidates.length} auto-approval(s) to submit (${irrevocableRoles} non revocable role(s), ${previouslyApproved} previously approved access, ${aiRecommended} AI recommended access)`
                )

                const { submitted, failed } = await this.submitDecisions(certification.id, candidates)
                if (failed.length > 0) {
                    this.trace('warn',
                        `Certification ${certification.id}: ${submitted.length} decision(s) applied, ${failed.length} refused by ISC, moving on to the next certification`
                    )
                } else {
                    this.trace('info',`Certification ${certification.id}: ${submitted.length} decision(s) applied`)
                }

                certifications.push({
                    certificationId: certification.id,
                    submitted: submitted.length,
                    failed: failed.length,
                    items: submitted,
                    errors: failed,
                })
                submittedDecisions.push(...submitted)
            } catch (error) {
                const description = describeApiError(error)
                this.trace('error',
                    `Certification ${certification.id} could not be processed, skipping it: ${description}`
                )
                certifications.push({
                    certificationId: certification.id,
                    submitted: 0,
                    failed: 0,
                    items: [],
                    errors: [],
                    skippedBecause: description,
                })
            }
        }

        const totals: PreApprovalTotals = {
            itemsProcessed,
            approvedFromPreviousCampaign: submittedDecisions.filter(
                (decision) =>
                    decision.reason === 'PREVIOUSLY_APPROVED' && decision.previousSource !== 'MOBILITY_MINI'
            ).length,
            approvedAsMandatory: submittedDecisions.filter(
                (decision) => decision.reason === 'IRREVOCABLE_ROLE'
            ).length,
            approvedFromMobilityMiniCampaign: submittedDecisions.filter(
                (decision) =>
                    decision.reason === 'PREVIOUSLY_APPROVED' && decision.previousSource === 'MOBILITY_MINI'
            ).length,
            approvedFromAiRecommendation: submittedDecisions.filter(
                (decision) => decision.reason === 'AI_RECOMMENDED'
            ).length,
        }

        logger.info(
            `Campaign ${campaignId}: ${totals.itemsProcessed} item(s) processed, ${totals.approvedAsMandatory} approved as mandatory, ${totals.approvedFromPreviousCampaign} approved from a previous campaign, ${totals.approvedFromMobilityMiniCampaign} approved from a mobility mini-campaign, ${totals.approvedFromAiRecommendation} approved from AI recommendation`
        )

        if (!this.debug) {
            return { campaignId, totals }
        }

        const totalSubmitted = certifications.reduce((total, entry) => total + entry.submitted, 0)
        const totalFailed = certifications.reduce((total, entry) => total + entry.errors.length, 0)
        const skipped = certifications.filter((entry) => entry.skippedBecause).length
        this.trace('info',
            `Campaign ${campaignId}: pre-approval done, ${totalSubmitted} decision(s) submitted, ${totalFailed} refused and ${skipped} certification(s) skipped on error, across ${certifications.length} certification(s)`
        )

        // The full trail stays in the CSV: returning it inline makes the response big enough for the
        // caller to time out and drop the connection before the command can answer.
        return {
            campaignId,
            totals,
            submitted: totalSubmitted,
            failed: totalFailed,
            loggedEvents: this.executionLogs.length,
            logCsvPath: this.writeExecutionLogCsv(campaignId),
            certifications,
        }
    }
}
