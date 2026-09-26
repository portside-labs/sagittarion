// The only way the orchestrator reaches a model. With a privacy session, every request is protected and verified
// before the adapter sees it, and answers are restored only for local use. Without one, the gateway carries the
// explicit reason it may send data as it is; there is no path that drops protection silently.
import type { AiTurn } from '@shared/ai'
import type { AiPrivacyReport, AiTranscriptEntry, PrivacyExemption, SealedText, SealedTurn } from '@shared/privacy'
import type { ChatRequest, ChatResponse, LlmProvider } from '../ai/providers/types'
import { sendUnprotected, textsUnprotected, type OutboundRequest } from './boundary'
import type { Restored } from './restore'
import { unrestored, type PrivacySession } from './session'
import type { SqlDialect } from './sql-regions'
import type { TextRole } from './types'

export class ModelGateway {
  private sent = 0

  private constructor(
    private readonly provider: LlmProvider,
    readonly privacy: PrivacySession | null,
    readonly exemption: PrivacyExemption | null,
    private readonly host: string
  ) {}

  static protected(provider: LlmProvider, session: PrivacySession): ModelGateway {
    return new ModelGateway(provider, session, null, session.host)
  }

  /** Data goes out as it is. The reason is required and ends up in the answer's privacy report. */
  static unprotected(provider: LlmProvider, exemption: PrivacyExemption, host: string): ModelGateway {
    return new ModelGateway(provider, null, exemption, host)
  }

  get kind(): string {
    return this.provider.kind
  }

  get model(): string {
    return this.provider.model
  }

  get supportsEmbeddings(): boolean {
    return this.provider.supportsEmbeddings
  }

  /** The request as it may leave: protected and verified, or marked with the exemption. */
  async prepare(req: ChatRequest): Promise<OutboundRequest> {
    return this.privacy ? this.privacy.protectRequest(req) : sendUnprotected(req, this.exemption!)
  }

  async send(req: OutboundRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const res = await this.provider.complete(req, signal)
    this.sent++
    return res
  }

  /** The response still speaks in placeholders; restore what is used locally with restoreText or restoreSql. */
  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.send(await this.prepare(req), signal)
  }

  async embed(texts: string[], signal?: AbortSignal, opts: { role?: TextRole } = {}): Promise<number[][]> {
    const outbound = this.privacy ? await this.privacy.protectTexts(texts, opts.role ?? 'prose') : textsUnprotected(texts, this.exemption!)
    return this.provider.embed(outbound, signal)
  }

  restoreText(text: string): Restored {
    return this.privacy ? this.privacy.restoreText(text) : unrestored(text)
  }

  restoreSql(sql: string, dialect: SqlDialect): Restored {
    return this.privacy ? this.privacy.restoreSql(sql, dialect) : unrestored(sql)
  }

  /** The text as the model will see it, for sealing a turn; null when nothing is protected. */
  seal(text: string, role: TextRole = 'prose'): Promise<SealedText> | null {
    return this.privacy ? this.privacy.seal(text, role) : null
  }

  adoptTurn(turn: AiTurn): SealedTurn | null {
    return this.privacy ? this.privacy.adoptTurn(turn) : null
  }

  /** The protected values of this ask for its transcript; none when nothing was protected. */
  transcriptLegend(sent: string[]): AiTranscriptEntry[] {
    return this.privacy ? this.privacy.transcriptLegend(sent) : []
  }

  report(sealed?: SealedTurn): AiPrivacyReport {
    if (this.privacy) return this.privacy.report(sealed)
    return {
      protected: false,
      exemption: this.exemption ?? undefined,
      host: this.host,
      counts: {},
      actions: {},
      requests: this.sent,
      restoration: { restored: 0, withheld: 0, unknown: 0, damaged: 0 },
      at: Date.now()
    }
  }
}
