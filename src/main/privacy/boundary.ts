// The trust boundary in types. Provider adapters accept only an OutboundRequest: either a ProtectedRequest, which
// only PrivacySession.protectRequest produces (after verification), or an UnprotectedRequest made here with a stated
// reason. A request assembled from database values cannot reach an adapter by accident; it takes a visible cast.
import type { PrivacyExemption } from '@shared/privacy'
import type { ChatRequest } from '../ai/providers/types'

declare const outbound: unique symbol

/** Detected, transformed under the policy and verified. The vault stays behind. */
export type ProtectedRequest = ChatRequest & { readonly [outbound]: 'protected' }

/** Sent as it is, for a reason named in the code that sends it. */
export type UnprotectedRequest = ChatRequest & { readonly [outbound]: 'unprotected' }

export type OutboundRequest = ProtectedRequest | UnprotectedRequest

/** Texts for an embeddings endpoint, under the same rule. */
export type OutboundTexts = readonly string[] & { readonly [outbound]: 'protected' | 'unprotected' }

/**
 * Why a request may go out unprotected:
 * - privacy-off: the user switched Local AI Privacy off
 * - this-device: the model runs on this computer and protecting it is not switched on
 * - fixed-text: the request holds only text written into the app, such as the connection test
 */
export type UnprotectedReason = PrivacyExemption | 'fixed-text'

export function sendUnprotected(req: ChatRequest, _reason: UnprotectedReason): UnprotectedRequest {
  return req as UnprotectedRequest
}

export function textsUnprotected(texts: string[], _reason: UnprotectedReason): OutboundTexts {
  return texts as unknown as OutboundTexts
}
