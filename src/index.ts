import {
    Context,
    createConnector,
    readConfig,
    Response,
    logger,
    StdAccountListOutput,
    StdAccountReadInput,
    StdAccountReadOutput,
    StdTestConnectionOutput,
    StdAccountListInput,
    StdTestConnectionInput,
} from '@sailpoint/connector-sdk'
import { MyClient } from './my-client'

// Connector must be exported as module property named connector
export const connector = async () => {
    // Get connector source config
    const config = await readConfig()

    // Use the vendor SDK, or implement own client as necessary, to initialize a client
    const myClient = new MyClient(config)

    return createConnector().command(
        'campaign:pre-approve',

        async (context: Context, input: { id: string }, res: Response<any>) => {
            try {
                res.send(await myClient.autoApproveCertificationItemsByCampaignId(input.id))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.error(`campaign:pre-approve failed for campaign ${input.id}: ${message}`)
                throw error
            }
        }
    )
}
