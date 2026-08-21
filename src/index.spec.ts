import { Connector } from '@sailpoint/connector-sdk'
import { PassThrough } from 'stream'
import { MyClient } from './my-client'
import { connector } from './index'

jest.mock('./my-client', () => ({
    MyClient: jest.fn().mockImplementation(() => ({
        autoApproveCertificationItemsByCampaignId: jest
            .fn()
            .mockResolvedValue({ campaignId: 'campaign-1', certifications: [] }),
    })),
}))

const mockConfig: any = {
    baseurl: 'https://example.api.identitynow.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    populationIdentityAttribute: 'population',
    employeePopulationValues: ['employé', 'employee'],
    contractorPopulationValues: ['prestataire', 'contractor'],
    employeeMaxPreviousCertificationAgeMonths: 12,
    employeeMobilityIdentityAttributes: ['department', 'manager'],
    contractorMaxPreviousCertificationAgeMonths: 24,
    contractorMobilityIdentityAttributes: [],
    debug: false,
}
process.env.CONNECTOR_CONFIG = Buffer.from(JSON.stringify(mockConfig)).toString('base64')

const mockContext: any = {
    reloadConfig: () => Promise.resolve(),
}

describe('connector unit tests', () => {
    beforeEach(() => {
        ;(MyClient as jest.Mock).mockClear()
    })

    it('connector SDK major version should be the same as Connector.SDK_VERSION', async () => {
        expect((await connector()).sdkVersion).toStrictEqual(Connector.SDK_VERSION)
    })

    it('should execute the campaign:pre-approve command', async () => {
        const chunks: any[] = []
        const output = new PassThrough({ objectMode: true }).on('data', (chunk) => chunks.push(chunk))

        const instance = await connector()
        await instance._exec('campaign:pre-approve', mockContext, { id: 'campaign-1' }, output)

        const client = (MyClient as jest.Mock).mock.results[0].value
        expect(client.autoApproveCertificationItemsByCampaignId).toHaveBeenCalledWith('campaign-1')
        expect(chunks).toHaveLength(1)
    })
})
