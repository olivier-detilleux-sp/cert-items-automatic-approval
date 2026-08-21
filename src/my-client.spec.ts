import { ConnectorError } from '@sailpoint/connector-sdk'
import { IAIRecommendationsApi } from 'sailpoint-api-client'
import { MyClient } from './my-client'

const mockConfig: any = {
    baseurl: 'https://example.api.identitynow.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    accessToken: 'xxx123',
    populationIdentityAttribute: 'population',
    employeePopulationValues: ['employé', 'employee'],
    contractorPopulationValues: ['prestataire', 'contractor'],
    employeeMaxPreviousCertificationAgeMonths: 12,
    employeeMobilityIdentityAttributes: ['department', 'manager'],
    contractorMaxPreviousCertificationAgeMonths: 24,
    contractorMobilityIdentityAttributes: [],
    debug: true,
}

function createClient(): MyClient {
    const client = new MyClient(mockConfig)
    jest.spyOn(client as any, 'getPopulationConfig').mockResolvedValue({
        population: 'EMPLOYEE',
        maxPreviousCertificationAgeMonths: 12,
        mobilityIdentityAttributes: new Set(['department', 'manager']),
    })
    jest.spyOn(client as any, 'getCertificationCampaignName').mockResolvedValue('Annual campaign')
    return client
}

describe('connector client unit tests', () => {
    it('rejects an incomplete configuration', () => {
        expect(() => new MyClient({})).toThrow(ConnectorError)
    })

    it('uses a recent previous certification when no mobility occurred', async () => {
        const myClient = createClient()
        const signedDate = new Date()
        signedDate.setUTCMonth(signedDate.getUTCMonth() - 1)

        jest.spyOn(myClient as any, 'getIdentityHistoryEvents').mockResolvedValue([
            {
                eventType: 'IdentityCertified',
                certificationId: 'previous-certification',
                signedDate: signedDate.toISOString(),
            },
        ])

        await expect(
            (myClient as any).getPreviousCertificationForIdentity('identity-1', new Set())
        ).resolves.toMatchObject({
            eligible: true,
            certification: { id: 'previous-certification' },
        })
    })

    it('rejects a previous certification older than the configured age', async () => {
        const myClient = createClient()
        const signedDate = new Date()
        signedDate.setUTCMonth(signedDate.getUTCMonth() - 13)

        jest.spyOn(myClient as any, 'getIdentityHistoryEvents').mockResolvedValue([
            {
                eventType: 'IdentityCertified',
                certificationId: 'old-certification',
                signedDate: signedDate.toISOString(),
            },
        ])

        await expect(
            (myClient as any).getPreviousCertificationForIdentity('identity-1', new Set())
        ).resolves.toMatchObject({
            eligible: false,
            certification: { id: 'old-certification' },
        })
    })

    it('rejects a previous certification after a configured mobility attribute changed', async () => {
        const myClient = createClient()
        const signedDate = new Date()
        signedDate.setUTCMonth(signedDate.getUTCMonth() - 1)
        const mobilityDate = new Date(signedDate)
        mobilityDate.setUTCDate(mobilityDate.getUTCDate() + 1)

        jest.spyOn(myClient as any, 'getIdentityHistoryEvents').mockResolvedValue([
            {
                eventType: 'IdentityCertified',
                certificationId: 'previous-certification',
                signedDate: signedDate.toISOString(),
            },
            {
                eventType: 'AttributesChanged',
                dateTime: mobilityDate.toISOString(),
                attributeChanges: [
                    {
                        name: 'department',
                        previousValue: 'Sales',
                        newValue: 'Finance',
                    },
                ],
            },
        ])

        await expect(
            (myClient as any).getPreviousCertificationForIdentity('identity-1', new Set())
        ).resolves.toMatchObject({
            eligible: false,
            certification: { id: 'previous-certification' },
        })
    })

    it('uses a mobility mini-certification when no later mobility occurred', async () => {
        const myClient = createClient()
        const mobilityDate = new Date()
        mobilityDate.setUTCMonth(mobilityDate.getUTCMonth() - 2)
        const signedDate = new Date(mobilityDate)
        signedDate.setUTCDate(signedDate.getUTCDate() + 2)

        ;(myClient as any).getCertificationCampaignName.mockResolvedValue(
            'Mini Certification Mobilité: changement unité'
        )
        jest.spyOn(myClient as any, 'getIdentityHistoryEvents').mockResolvedValue([
            {
                eventType: 'AttributesChanged',
                dateTime: mobilityDate.toISOString(),
                attributeChanges: [
                    { name: 'department', previousValue: 'Sales', newValue: 'Finance' },
                ],
            },
            {
                eventType: 'IdentityCertified',
                certificationId: 'mobility-certification',
                signedDate: signedDate.toISOString(),
            },
        ])

        const result = await (myClient as any).getPreviousCertificationForIdentity(
            'identity-1',
            new Set()
        )

        expect(result).toMatchObject({
            eligible: true,
            certification: {
                id: 'mobility-certification',
                source: 'MOBILITY_MINI',
            },
        })
        expect(result.certification.mobilityAt.toISOString()).toBe(mobilityDate.toISOString())
    })

    it('resolves the access id from the type specific summary when access is not filled', () => {
        const myClient = createClient()
        const previousApprovedAccess = new Map([
            [
                'identity-1',
                {
                    certificationId: 'july-campaign',
                    signedAt: new Date('2026-07-28T10:00:00.000Z'),
                    source: 'ANNUAL',
                    keys: new Set(['ENTITLEMENT:entitlement-1']),
                },
            ],
        ])

        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'item-without-access-summary',
                    newAccess: false,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        entitlement: { id: 'entitlement-1', name: 'GG_INFRA_WIFI_Paris' },
                    },
                },
            ],
            previousApprovedAccess
        )

        expect(candidates[0]).toMatchObject({
            itemId: 'item-without-access-summary',
            accessId: 'entitlement-1',
            accessType: 'ENTITLEMENT',
            reason: 'PREVIOUSLY_APPROVED',
        })
    })

    it('reads the previous certification once to know both approved and revoked access', async () => {
        const myClient = createClient()
        const signedDate = new Date()
        signedDate.setUTCMonth(signedDate.getUTCMonth() - 1)

        const getHistory = jest
            .spyOn(myClient as any, 'getIdentityHistoryEvents')
            .mockResolvedValue([
                {
                    eventType: 'IdentityCertified',
                    certificationId: 'previous-certification',
                    signedDate: signedDate.toISOString(),
                },
            ])
        const getItems = jest
            .spyOn(myClient as any, 'getCertificationItemsByCertificationId')
            .mockResolvedValue([
                {
                    identitySummary: { identityId: 'identity-1' },
                    decision: 'APPROVE',
                    accessSummary: { access: { type: 'ENTITLEMENT', id: 'kept-access' } },
                },
                {
                    identitySummary: { identityId: 'identity-1' },
                    decision: 'REVOKE',
                    accessSummary: { access: { type: 'ENTITLEMENT', id: 'revoked-access' } },
                },
            ])

        const result = await (myClient as any).getPreviousCertificationDecisionsByIdentity(
            new Set(['identity-1']),
            new Set()
        )

        expect(getHistory).toHaveBeenCalledTimes(1)
        expect(getItems).toHaveBeenCalledTimes(1)
        expect([...result.approved.get('identity-1').keys]).toEqual(['ENTITLEMENT:kept-access'])
        expect([...result.revoked.get('identity-1')]).toEqual(['ENTITLEMENT:revoked-access'])
    })

    it('does not search again when the identity has no previous certification', async () => {
        const myClient = createClient()
        const getHistory = jest
            .spyOn(myClient as any, 'getIdentityHistoryEvents')
            .mockResolvedValue([])
        const getItems = jest.spyOn(myClient as any, 'getCertificationItemsByCertificationId')

        const result = await (myClient as any).getPreviousCertificationDecisionsByIdentity(
            new Set(['identity-1']),
            new Set()
        )

        expect(getHistory).toHaveBeenCalledTimes(1)
        expect(getItems).not.toHaveBeenCalled()
        expect(result.approved.size).toBe(0)
        expect(result.revoked.size).toBe(0)
    })

    it('keeps the revocations of a previous certification discarded by the age rule', async () => {
        const myClient = createClient()
        const signedDate = new Date()
        signedDate.setUTCMonth(signedDate.getUTCMonth() - 13)

        jest.spyOn(myClient as any, 'getIdentityHistoryEvents').mockResolvedValue([
            {
                eventType: 'IdentityCertified',
                certificationId: 'old-certification',
                signedDate: signedDate.toISOString(),
            },
        ])
        jest.spyOn(myClient as any, 'getCertificationItemsByCertificationId').mockResolvedValue([
            {
                identitySummary: { identityId: 'identity-1' },
                decision: 'REVOKE',
                accessSummary: { access: { type: 'ENTITLEMENT', id: 'revoked-access' } },
            },
        ])

        const result = await (myClient as any).getPreviousCertificationDecisionsByIdentity(
            new Set(['identity-1']),
            new Set()
        )

        expect(result.approved.size).toBe(0)
        expect([...result.revoked.get('identity-1')]).toEqual(['ENTITLEMENT:revoked-access'])
    })

    it('mentions the mobility date in decisions based on a mini-certification', () => {
        const myClient = createClient()
        const mobilityAt = new Date('2026-03-15T10:00:00.000Z')
        const previousApprovedAccess = new Map([
            [
                'identity-1',
                {
                    certificationId: 'mobility-certification',
                    signedAt: new Date('2026-03-17T10:00:00.000Z'),
                    source: 'MOBILITY_MINI',
                    mobilityAt,
                    keys: new Set(['ENTITLEMENT:access-1']),
                },
            ],
        ])

        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'item-1',
                    newAccess: false,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ENTITLEMENT', id: 'access-1', name: 'Access 1' },
                    },
                },
            ],
            previousApprovedAccess
        )

        expect(candidates[0].comments).toBe(
            'Pré-validation car déjà approuvé lors de la mini certification liée à la mobilité du 15/03/2026'
        )
    })

    it('does not pre-approve recertified access that was revoked in the last campaign even if it looks like existing access', () => {
        const myClient = createClient()
        const previousApprovedAccess = new Map([
            [
                'identity-1',
                {
                    certificationId: 'july-campaign',
                    signedAt: new Date('2026-07-28T10:00:00.000Z'),
                    source: 'ANNUAL',
                    keys: new Set(['ENTITLEMENT:kept-access']),
                },
            ],
        ])

        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'item-revoked-then-requested',
                    newAccess: false,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: {
                            type: 'ENTITLEMENT',
                            id: 'revoked-access',
                            name: 'Revoked then requested',
                        },
                    },
                },
                {
                    id: 'item-kept',
                    newAccess: false,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ENTITLEMENT', id: 'kept-access', name: 'Kept access' },
                    },
                },
            ],
            previousApprovedAccess
        )

        expect(candidates.map((candidate: { itemId: string }) => candidate.itemId)).toEqual(['item-kept'])
    })

    it('uses AI NO as a veto and AI YES as a fallback when no business rule applies', () => {
        const myClient = createClient()
        const items = [
            {
                id: 'mandatory-role',
                identitySummary: { identityId: 'identity-1' },
                accessSummary: {
                    access: { type: 'ROLE', id: 'role-1', name: 'Mandatory role' },
                    role: { revocable: false },
                },
            },
            {
                id: 'new-ai-access',
                newAccess: true,
                identitySummary: { identityId: 'identity-1' },
                accessSummary: {
                    access: { type: 'ENTITLEMENT', id: 'access-ai', name: 'AI access' },
                },
            },
        ]
        const recommendations = new Map([
            ['identity-1|ROLE:role-1', 'NO'],
            ['identity-1|ENTITLEMENT:access-ai', 'YES'],
        ])

        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            items,
            new Map(),
            recommendations,
            new Map()
        )

        expect(candidates).toHaveLength(1)
        expect(candidates[0]).toMatchObject({
            itemId: 'new-ai-access',
            reason: 'AI_RECOMMENDED',
        })
        expect(candidates[0].comments).toContain('moteur AI de SailPoint')
    })

    it('applies a business rule despite AI NO when businessRulesOverrideAiNo is enabled', () => {
        const myClient = new MyClient({
            ...mockConfig,
            businessRulesOverrideAiNo: true,
        })
        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'mandatory-role',
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ROLE', id: 'role-1', name: 'Mandatory role' },
                        role: { revocable: false },
                    },
                },
                {
                    id: 'new-access',
                    newAccess: true,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ENTITLEMENT', id: 'access-ai', name: 'AI access' },
                    },
                },
            ],
            new Map(),
            new Map([
                ['identity-1|ROLE:role-1', 'NO'],
                ['identity-1|ENTITLEMENT:access-ai', 'NO'],
            ]),
            new Map()
        )

        expect(candidates).toHaveLength(1)
        expect(candidates[0]).toMatchObject({
            itemId: 'mandatory-role',
            reason: 'IRREVOCABLE_ROLE',
        })
    })

    it('keeps business rules when AI has no recommendation', () => {
        const myClient = createClient()
        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'mandatory-role',
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ROLE', id: 'role-1', name: 'Mandatory role' },
                        role: { revocable: false },
                    },
                },
            ],
            new Map(),
            new Map([['identity-1|ROLE:role-1', 'MAYBE']]),
            new Map()
        )

        expect(candidates[0].reason).toBe('IRREVOCABLE_ROLE')
    })

    it('does not approve AI recommended access revoked in the last certification by default', () => {
        const myClient = createClient()
        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'revoked-ai-access',
                    newAccess: false,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ENTITLEMENT', id: 'access-1', name: 'Revoked access' },
                    },
                },
            ],
            new Map(),
            new Map([['identity-1|ENTITLEMENT:access-1', 'YES']]),
            new Map([['identity-1', new Set(['ENTITLEMENT:access-1'])]])
        )

        expect(candidates).toEqual([])
    })

    it('can approve AI recommended access revoked in the last certification when configured', () => {
        const myClient = new MyClient({
            ...mockConfig,
            approveAiRecommendedPreviouslyRevoked: true,
        })
        const candidates = (myClient as any).evaluateItems(
            'current-certification',
            [
                {
                    id: 'revoked-ai-access',
                    newAccess: false,
                    identitySummary: { identityId: 'identity-1' },
                    accessSummary: {
                        access: { type: 'ENTITLEMENT', id: 'access-1', name: 'Revoked access' },
                    },
                },
            ],
            new Map(),
            new Map([['identity-1|ENTITLEMENT:access-1', 'YES']]),
            new Map([['identity-1', new Set(['ENTITLEMENT:access-1'])]])
        )

        expect(candidates[0].reason).toBe('AI_RECOMMENDED')
        expect(candidates[0].comments).toContain('malgré une révocation')
    })

    it('deduplicates and batches AI recommendation requests', async () => {
        const getRecommendations = jest
            .spyOn(IAIRecommendationsApi.prototype, 'getRecommendationsV1')
            .mockImplementation(async ({ recommendationRequestDto }: any) => ({
                data: {
                    response: recommendationRequestDto.requests.map((request: any) => ({
                        request,
                        recommendation: 'YES',
                    })),
                },
            }) as any)
        const myClient = new MyClient({
            ...mockConfig,
            enableAiRecommendations: true,
            aiRecommendationBatchSize: 2,
        })
        const item = (id: string, accessId: string) => ({
            id,
            identitySummary: { identityId: 'identity-1' },
            accessSummary: {
                access: { type: 'ENTITLEMENT', id: accessId, name: accessId },
            },
        })

        const result = await (myClient as any).getAiRecommendations([
            item('item-1', 'access-1'),
            item('item-1-duplicate', 'access-1'),
            item('item-2', 'access-2'),
            item('item-3', 'access-3'),
        ])

        expect(getRecommendations).toHaveBeenCalledTimes(2)
        expect(result.size).toBe(3)
        expect(getRecommendations.mock.calls[0][0].xSailPointExperimental).toBe('true')
        getRecommendations.mockRestore()
    })

    it('reads the recommendations from the responses field returned by ISC', async () => {
        const getRecommendations = jest
            .spyOn(IAIRecommendationsApi.prototype, 'getRecommendationsV1')
            .mockImplementation(async ({ recommendationRequestDto }: any) => ({
                data: {
                    responses: recommendationRequestDto.requests.map((request: any) => ({
                        request,
                        recommendation: 'YES',
                        interpretations: [],
                        translationMessages: [],
                        recommenderCalculations: null,
                    })),
                },
            }) as any)
        const myClient = new MyClient({ ...mockConfig, enableAiRecommendations: true })

        const result = await (myClient as any).getAiRecommendations([
            {
                id: 'item-1',
                identitySummary: { identityId: 'identity-1' },
                accessSummary: {
                    access: { type: 'ENTITLEMENT', id: 'access-1', name: 'Access 1' },
                },
            },
        ])

        expect(result.get('identity-1|ENTITLEMENT:access-1')).toBe('YES')
        getRecommendations.mockRestore()
    })

    it('maps recommendations by request order when the API does not echo the request', async () => {
        const getRecommendations = jest
            .spyOn(IAIRecommendationsApi.prototype, 'getRecommendationsV1')
            .mockImplementation(async ({ recommendationRequestDto }: any) => ({
                data: {
                    response: recommendationRequestDto.requests.map((_: unknown, index: number) => ({
                        recommendation: index === 0 ? 'YES' : 'NO',
                    })),
                },
            }) as any)
        const myClient = new MyClient({ ...mockConfig, enableAiRecommendations: true })
        const item = (id: string, accessId: string) => ({
            id,
            identitySummary: { identityId: 'identity-1' },
            accessSummary: {
                access: { type: 'ENTITLEMENT', id: accessId, name: accessId },
            },
        })

        const result = await (myClient as any).getAiRecommendations([
            item('item-1', 'access-1'),
            item('item-2', 'access-2'),
        ])

        expect(result.get('identity-1|ENTITLEMENT:access-1')).toBe('YES')
        expect(result.get('identity-1|ENTITLEMENT:access-2')).toBe('NO')
        getRecommendations.mockRestore()
    })

    it('does not guess a recommendation when the response size does not match the request', async () => {
        const getRecommendations = jest
            .spyOn(IAIRecommendationsApi.prototype, 'getRecommendationsV1')
            .mockResolvedValue({
                data: { response: [{ recommendation: 'YES' }] },
            } as any)
        const myClient = new MyClient({ ...mockConfig, enableAiRecommendations: true })
        const item = (id: string, accessId: string) => ({
            id,
            identitySummary: { identityId: 'identity-1' },
            accessSummary: {
                access: { type: 'ENTITLEMENT', id: accessId, name: accessId },
            },
        })

        const result = await (myClient as any).getAiRecommendations([
            item('item-1', 'access-1'),
            item('item-2', 'access-2'),
        ])

        expect(result.size).toBe(0)
        getRecommendations.mockRestore()
    })

    it('keeps the valid decisions of a batch rejected by ISC and reports the refused ones', async () => {
        const myClient = createClient()
        const forbiddenItem = 'item-forbidden'
        const makeIdentityDecisionV1 = jest.fn(({ reviewDecision }: any) => {
            if (reviewDecision.some((decision: any) => decision.id === forbiddenItem)) {
                return Promise.reject({
                    message: 'Request failed with status code 400',
                    response: { status: 400, data: { messages: ['self certification is not allowed'] } },
                })
            }
            return Promise.resolve({ data: {} })
        })
        jest.spyOn(myClient as any, 'getApi').mockReturnValue({ makeIdentityDecisionV1 })

        const candidates = [
            { itemId: 'item-ok', identityId: 'identity-1', decision: 'APPROVE', comments: '', reason: 'IRREVOCABLE_ROLE' },
            { itemId: forbiddenItem, identityId: 'identity-2', decision: 'APPROVE', comments: '', reason: 'IRREVOCABLE_ROLE' },
        ]

        const result = await (myClient as any).submitDecisions('certification-1', candidates)

        expect(result.submitted).toHaveLength(1)
        expect(result.submitted[0].itemId).toBe('item-ok')
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0]).toMatchObject({ itemId: forbiddenItem, identityId: 'identity-2' })
        expect(result.failed[0].error).toContain('self certification is not allowed')
    })

    it('skips a certification that fails and keeps processing the next ones', async () => {
        const myClient = createClient()

        jest.spyOn(myClient as any, 'getCertificationItemsByCampaignId').mockResolvedValue([
            { certification: { id: 'certification-ko' }, items: [] },
            { certification: { id: 'certification-ok' }, items: [] },
        ])
        jest.spyOn(myClient as any, 'getPreviousCertificationDecisionsByIdentity').mockResolvedValue({
            approved: new Map(),
            revoked: new Map(),
        })
        jest.spyOn(myClient as any, 'evaluateItems').mockImplementation((certificationId: unknown) => {
            if (certificationId === 'certification-ko') {
                throw { message: 'Request failed with status code 400', response: { status: 400 } }
            }
            return []
        })

        const result = await myClient.autoApproveCertificationItemsByCampaignId('campaign-1')

        expect(result.certifications).toHaveLength(2)
        expect(result.certifications?.[0].skippedBecause).toContain('HTTP 400')
        expect(result.certifications?.[1].skippedBecause).toBeUndefined()
        expect(result.logCsvPath).toBeDefined()
        expect((result as any).logs).toBeUndefined()
        expect(result.loggedEvents).toBeGreaterThan(0)
        expect(result.totals).toMatchObject({
            itemsProcessed: 0,
            approvedFromPreviousCampaign: 0,
            approvedAsMandatory: 0,
            approvedFromMobilityMiniCampaign: 0,
        })
    })

    it('returns only totals when debug is disabled', async () => {
        const myClient = new MyClient({ ...mockConfig, debug: false })
        jest.spyOn(myClient as any, 'getCertificationItemsByCampaignId').mockResolvedValue([
            { certification: { id: 'certification-ok' }, items: [] },
        ])
        jest.spyOn(myClient as any, 'getPreviousCertificationDecisionsByIdentity').mockResolvedValue({
            approved: new Map(),
            revoked: new Map(),
        })
        jest.spyOn(myClient as any, 'evaluateItems').mockReturnValue([])

        const result = await myClient.autoApproveCertificationItemsByCampaignId('campaign-1')

        expect(result.totals.itemsProcessed).toBe(0)
        expect(result.certifications).toBeUndefined()
        expect(result.loggedEvents).toBeUndefined()
        expect(result.logCsvPath).toBeUndefined()
    })
})
