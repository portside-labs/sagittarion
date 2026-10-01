// Tool calls waiting for the user: the chat shows each one with its arguments and answers allow once, always, or deny.
import { randomUUID } from 'node:crypto'
import type { ConnectorTool, ToolApprovalDecision, ToolApprovalRequest } from '@shared/connectors'
import { ProviderError } from '../ai/providers/types'
import type { Connector } from './store'

const DECISIONS: ToolApprovalDecision[] = ['once', 'always', 'deny']

export class ApprovalBroker {
  private readonly pending = new Map<string, { requestId: string; resolve: (d: ToolApprovalDecision) => void }>()

  constructor(private readonly show: (req: ToolApprovalRequest) => void) {}

  /** Asks the user; a cancelled ask cancels the question with it. */
  request(requestId: string, connector: Connector, tool: ConnectorTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolApprovalDecision> {
    if (signal?.aborted) return Promise.reject(new ProviderError('Cancelled.', 'cancelled'))
    const approvalId = randomUUID()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(approvalId)
        reject(new ProviderError('Cancelled.', 'cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(approvalId, {
        requestId,
        resolve: (d) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(d)
        }
      })
      this.show({ requestId, approvalId, connector: { id: connector.id, name: connector.name }, tool, args })
    })
  }

  answer(approvalId: string, decision: ToolApprovalDecision): void {
    const p = this.pending.get(approvalId)
    if (!p || !DECISIONS.includes(decision)) return
    this.pending.delete(approvalId)
    p.resolve(decision)
  }
}
