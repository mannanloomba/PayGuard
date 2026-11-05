import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertTriangle, ArrowUp, Bot, Check, Clock3, LoaderCircle, Plus,
  ShieldCheck, Sparkles, UserRound, X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatCurrency } from './payment-format'
import { apiFetch } from './api-client'

type AgentAction =
  | 'none'
  | 'create_payment_rule'
  | 'set_payment_limit'
  | 'pause_payment_rule'
  | 'resume_payment_rule'
  | 'set_bill_reminder'
  | 'query_upcoming_payments'
  | 'prepare_universal_payment'
  | 'query_transactions'
  | 'find_risky_payments'
  | 'query_spending'
  | 'query_duplicates'
  | 'query_bill_comparison'
  | 'explain_unusual_spending'
  | 'compare_qr_recipient'

type PaymentFrequency = 'weekly' | 'monthly'
type Currency = 'USD' | 'INR'
type UniversalCategory =
  | 'person_to_person'
  | 'merchant'
  | 'qr_payment'
  | 'scheduled_transfer'
  | 'account_transfer'
  | 'utility_bill'
  | 'invoice'
  | 'subscription'
  | 'everyday'

type AgentProposal = {
  proposal_id?: string
  confirmation_token?: string
  expires_at?: string
  action: AgentAction
  message: string
  recipient: string | null
  rule_id: string | null
  amount: number | null
  maximum_limit: number | null
  currency: Currency | null
  frequency: PaymentFrequency | null
  payment_day: number | null
  start_date: string | null
  reminder_due_date: string | null
  recipient_id: string | null
  payment_category: UniversalCategory | null
  purpose: string | null
  payment_date: string | null
  order_reference: string | null
  recurrence: PaymentFrequency | null
  qr_recipient_identifier: string | null
  risk?: { level: 'Low' | 'Medium' | 'High'; score: number; evidence: { type: string; points: number; details?: unknown }[]; recommended_action: string; duplicate_blocked: boolean }
  is_active?: boolean
  missing_fields: string[]
}

type AssistantRecipient = {
  id: string
  name: string
  identifier: string
  recipient_type: string
  is_verified: boolean
}

type ScheduledItem = {
  rule_id?: string
  recipient: string
  amount: number | null
  maximum_limit?: number
  currency: Currency | null
  payment_date: string
  status: string
  type: string
  details?: string
  exceeds_limit?: boolean
  recipient_changed?: boolean
  details_changed?: boolean
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  schedule?: ScheduledItem[] | null
}

type InterpretResponse = {
  message: string
  proposal: AgentProposal | null
  upcoming_payments: ScheduledItem[] | null
}

const STORAGE_KEY = 'payguard-assistant-history'
const SUGGESTIONS = [
  'Create a monthly rule for my electricity provider',
  'Set a ₹3,000 limit for Electricity Provider',
  'Pause my electricity payment rule',
  'What payments are coming up?',
  'Remind me when my internet bill is due on 2026-12-10',
  'Send ₹2,000 to my saved recipient',
  'Show my transfers this month',
  'Find suspicious payments',
  'How much did I spend on subscriptions?',
  'Find duplicate transactions',
  'Compare my electricity bills',
  'Explain unusual spending',
  'Show my upcoming bills',
  'Check whether a UPI QR is suspicious',
  'Compare this QR recipient with my saved recipients',
]

function initialMessages(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as ChatMessage[]
      if (Array.isArray(parsed) && parsed.every((message) =>
        typeof message.id === 'string'
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
      )) return parsed
    }
  } catch {
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      return [{
        id: 'welcome',
        role: 'assistant',
        content: 'Hi! I can help prepare a payment request, manage a rule or reminder, and review saved payment history. I’ll ask when details are missing; payments need your review and separate sandbox approval.',
      }]
    }
  }
  return [{
    id: 'welcome',
    role: 'assistant',
    content: 'Hi! I can help prepare a payment request, manage a rule or reminder, and review saved payment history. I’ll ask when details are missing; payments need your review and separate sandbox approval.',
  }]
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json() as { detail?: string | { msg?: string }[] }
      if (typeof body.detail === 'string') message = body.detail
      else if (Array.isArray(body.detail)) message = body.detail.map((entry: { msg?: string }) => entry.msg).filter(Boolean).join(', ')
    } catch {
      // Retain the HTTP status when the server does not return JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function requiredFields(proposal: AgentProposal): string[] {
  const requiredByAction: Partial<Record<AgentAction, [string, unknown][]>> = {
    create_payment_rule: [
      ['recipient', proposal.recipient],
      ['amount', proposal.amount],
      ['maximum_limit', proposal.maximum_limit],
      ['currency', proposal.currency],
      ['frequency', proposal.frequency],
      ['payment_day', proposal.payment_day],
      ['start_date', proposal.start_date],
    ],
    set_payment_limit: [
      ['recipient', proposal.recipient],
      ['rule_id', proposal.rule_id],
      ['maximum_limit', proposal.maximum_limit],
      ['currency', proposal.currency],
    ],
    pause_payment_rule: [['recipient', proposal.recipient], ['rule_id', proposal.rule_id]],
    resume_payment_rule: [['recipient', proposal.recipient], ['rule_id', proposal.rule_id]],
    set_bill_reminder: [['recipient', proposal.recipient], ['reminder_due_date', proposal.reminder_due_date]],
    prepare_universal_payment: [
      ['recipient_id', proposal.recipient_id],
      ['payment_category', proposal.payment_category],
      ['amount', proposal.amount],
      ['currency', proposal.currency],
      ['purpose', proposal.purpose],
      ['payment_date', proposal.payment_date],
      ...(proposal.payment_category === 'merchant' ? [['order_reference', proposal.order_reference] as [string, unknown]] : []),
      ...(['scheduled_transfer', 'subscription'].includes(proposal.payment_category ?? '') ? [['recurrence', proposal.recurrence] as [string, unknown]] : []),
    ],
  }
  const missing = (requiredByAction[proposal.action] ?? [])
    .filter(([, value]) => value === null || value === undefined || value === '')
    .map(([field]) => field)
  if (
    proposal.action === 'prepare_universal_payment'
    && proposal.payment_category === 'qr_payment'
    && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}@[A-Za-z][A-Za-z0-9.-]{0,62}$/.test(proposal.qr_recipient_identifier ?? '')
  ) {
    missing.push('qr_recipient_identifier')
  }
  return missing
}

function actionTitle(action: AgentAction) {
  switch (action) {
    case 'create_payment_rule': return 'Recurring payment rule'
    case 'set_payment_limit': return 'Approval limit change'
    case 'pause_payment_rule': return 'Pause payment rule'
    case 'resume_payment_rule': return 'Resume payment rule'
    case 'set_bill_reminder': return 'Bill reminder'
    case 'prepare_universal_payment': return 'Universal payment request'
    default: return 'Payment instruction'
  }
}

function fieldLabel(field: string) {
  return ({
    recipient: 'recipient/provider',
    rule_id: 'a matching saved rule',
    amount: 'payment amount',
    maximum_limit: 'maximum payment limit',
    currency: 'currency',
    frequency: 'weekly or monthly frequency',
    payment_day: 'payment day',
    start_date: 'start date',
    reminder_due_date: 'bill due date',
    recipient_id: 'a saved recipient',
    payment_category: 'payment category',
    purpose: 'payment purpose',
    payment_date: 'payment date',
    order_reference: 'merchant order reference',
    recurrence: 'weekly or monthly recurrence',
    qr_recipient_identifier: 'a valid decoded UPI ID',
  } as Record<string, string>)[field] ?? field.replace(/_/g, ' ')
}

function Assistant() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [input, setInput] = useState('')
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [recipients, setRecipients] = useState<AssistantRecipient[]>([])
  const [riskChecking, setRiskChecking] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.map(({ id, role, content }) => ({ id, role, content }))))
    } catch {
      setError('Conversation history could not be saved in this browser session.')
    }
  }, [messages])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, proposal, busy])

  useEffect(() => {
    apiRequest<AssistantRecipient[]>('/api/payment-recipients')
      .then(setRecipients)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not load saved recipients.'))
  }, [])

  useEffect(() => {
    if (!proposal || proposal.action !== 'prepare_universal_payment' || requiredFields(proposal).length > 0) {
      setRiskChecking(false)
      return
    }
    let active = true
    setRiskChecking(true)
    setError(null)
    apiRequest<NonNullable<AgentProposal['risk']>>('/api/universal-payment-risk', {
      method: 'POST',
      body: JSON.stringify({
        recipient_id: proposal.recipient_id,
        category: proposal.payment_category,
        amount: proposal.amount,
        currency: proposal.currency,
        purpose: proposal.purpose,
        payment_date: proposal.payment_date,
        order_reference: proposal.order_reference,
        recurrence: proposal.recurrence,
        qr_recipient_identifier: proposal.qr_recipient_identifier,
      }),
    }).then((risk) => {
      if (active) setProposal((current) => current?.action === 'prepare_universal_payment' ? { ...current, risk } : current)
    }).catch((riskError: unknown) => {
      if (active) setError(riskError instanceof Error ? `Could not complete the required risk review: ${riskError.message}` : 'Could not complete the required risk review.')
    }).finally(() => {
      if (active) setRiskChecking(false)
    })
    return () => { active = false }
  }, [
    proposal?.action,
    proposal?.recipient_id,
    proposal?.payment_category,
    proposal?.amount,
    proposal?.currency,
    proposal?.purpose,
    proposal?.payment_date,
    proposal?.order_reference,
    proposal?.recurrence,
    proposal?.qr_recipient_identifier,
  ])

  function appendAssistant(content: string, schedule?: ScheduledItem[] | null) {
    setMessages((current) => [...current, {
      id: `${Date.now()}-${Math.random()}`,
      role: 'assistant',
      content,
      schedule,
    }])
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>, suggested?: string) {
    event?.preventDefault()
    const content = (suggested ?? input).trim()
    if (!content || busy) return
    const userMessage: ChatMessage = { id: `${Date.now()}-${Math.random()}`, role: 'user', content }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setBusy(true)
    setError(null)
    setNotice(null)
    setProposal(null)
    try {
      const result = await apiRequest<InterpretResponse>('/api/assistant/interpret', {
        method: 'POST',
        body: JSON.stringify({
          messages: nextMessages.slice(-20).map(({ role, content: text }) => ({ role, content: text })),
        }),
      })
      appendAssistant(result.message, result.upcoming_payments)
      setProposal(result.proposal)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The assistant could not process that message.')
    } finally {
      setBusy(false)
    }
  }

  function updateProposal<K extends keyof AgentProposal>(key: K, value: AgentProposal[K]) {
    setProposal((current) => current
      ? { ...current, [key]: value, ...(current.action === 'prepare_universal_payment' ? { risk: undefined } : {}) }
      : current)
  }

  async function confirmProposal() {
    if (!proposal || requiredFields(proposal).length > 0 || (proposal.action === 'prepare_universal_payment' && (!proposal.risk || riskChecking))) return
    setConfirming(true)
    setError(null)
    setNotice(null)
    try {
      switch (proposal.action) {
        case 'create_payment_rule':
          await apiRequest('/api/assistant/confirm', {
            method: 'POST',
            body: JSON.stringify({
              proposal_id: proposal.proposal_id,
              confirmation_token: proposal.confirmation_token,
            }),
          })
          setNotice('Payment rule saved. Schedule previews do not initiate payments.')
          break
        case 'set_payment_limit':
          await apiRequest('/api/assistant/confirm', {
            method: 'POST',
            body: JSON.stringify({
              proposal_id: proposal.proposal_id,
              confirmation_token: proposal.confirmation_token,
            }),
          })
          setNotice('Approval limit updated after your confirmation.')
          break
        case 'pause_payment_rule':
        case 'resume_payment_rule':
          await apiRequest('/api/assistant/confirm', {
            method: 'POST',
            body: JSON.stringify({
              proposal_id: proposal.proposal_id,
              confirmation_token: proposal.confirmation_token,
            }),
          })
          setNotice(proposal.action === 'pause_payment_rule' ? 'Payment rule paused.' : 'Payment rule resumed.')
          break
        case 'set_bill_reminder':
          await apiRequest('/api/assistant/confirm', {
            method: 'POST',
            body: JSON.stringify({
              proposal_id: proposal.proposal_id,
              confirmation_token: proposal.confirmation_token,
            }),
          })
          setNotice('Bill reminder saved.')
          break
        case 'prepare_universal_payment':
          await apiRequest('/api/assistant/confirm', {
            method: 'POST',
            body: JSON.stringify({
              proposal_id: proposal.proposal_id,
              confirmation_token: proposal.confirmation_token,
            }),
          })
          setNotice('Payment request prepared. It is not approved or sent; review it separately in Payments.')
          break
        default:
          return
      }
      const completed = actionTitle(proposal.action).toLowerCase()
      appendAssistant(
        proposal.action === 'prepare_universal_payment'
          ? 'Payment request prepared after your confirmation. No payment was made; sandbox approval remains a separate action in Payments.'
          : `${completed} confirmed and saved. No payment was made.`,
      )
      setProposal(null)
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : 'The confirmed action could not be saved.')
    } finally {
      setConfirming(false)
    }
  }

  function newConversation() {
    setMessages([{
      id: `${Date.now()}-welcome`,
      role: 'assistant',
      content: 'New conversation. What would you like to set up or check?',
    }])
    setProposal(null)
    setError(null)
    setNotice(null)
    sessionStorage.removeItem(STORAGE_KEY)
  }

  const missing = proposal ? requiredFields(proposal) : []

  return (
    <div className="page-enter mx-auto max-w-5xl space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium text-electric"><Sparkles size={14} /> PayGuard Assistant</p>
          <h2 className="mt-1 text-[25px] font-semibold tracking-tight text-slate-900">How can I help?</h2>
          <p className="mt-1 text-sm text-slate-500">Ask about saved payments, scan a UPI QR, or prepare a reviewed payment request.</p>
        </div>
        <button type="button" onClick={newConversation} className="inline-flex h-9 items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:self-auto">
          <Plus size={14} /> New conversation
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,.7fr)]">
        <section className="flex min-h-[580px] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card" aria-label="Payment assistant conversation">
          <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-electric"><Bot size={19} /></div>
            <div><p className="text-sm font-semibold text-slate-800">Payment assistant</p><p className="mt-0.5 text-[11px] text-slate-400">BharatCode · saved payment and bill data · confirmation required</p></div>
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700"><ShieldCheck size={12} /> Confirmation required</span>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5" aria-live="polite">
            {messages.map((message) => (
              <div key={message.id} className={`flex items-start gap-2.5 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${message.role === 'user' ? 'bg-[#e6ecff] text-[#4056b4]' : 'bg-blue-50 text-electric'}`}>
                  {message.role === 'user' ? <UserRound size={15} /> : <Bot size={16} />}
                </div>
                <div className={`max-w-[88%] space-y-3 ${message.role === 'user' ? 'items-end' : ''}`}>
                  <p className={`whitespace-pre-wrap rounded-2xl px-3.5 py-3 text-sm leading-relaxed ${message.role === 'user' ? 'rounded-tr-md bg-electric text-white' : 'rounded-tl-md bg-slate-50 text-slate-700'}`}>{message.content}</p>
                  {message.schedule && message.schedule.length > 0 && (
                    <div className="space-y-2">
                      {message.schedule.slice(0, 8).map((item, index) => (
                        <div key={`${item.rule_id ?? item.recipient}-${item.payment_date}-${index}`} className="rounded-xl border border-slate-100 bg-white p-3">
                          <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold text-slate-800">{item.recipient}</p>{item.amount !== null && <span className="text-xs font-semibold text-slate-800">{formatCurrency(item.amount, item.currency ?? 'USD')}</span>}</div>
                          <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500"><Clock3 size={11} />{item.payment_date} · {item.status.replace(/_/g, ' ')}</p>
                          {item.details && <p className="mt-1 text-[11px] text-slate-500">{item.details}</p>}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {item.exceeds_limit && <span className="rounded-full bg-rose-50 px-2 py-1 text-[10px] font-medium text-rose-700">Over limit</span>}
                            {item.recipient_changed && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700">Recipient changed</span>}
                            {item.details_changed && !item.recipient_changed && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700">Details changed</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-2.5 text-xs text-slate-500"><span className="grid h-8 w-8 place-items-center rounded-full bg-blue-50 text-electric"><Bot size={16} /></span><LoaderCircle size={14} className="animate-spin" /> Thinking…</div>}
            <div ref={endRef} />
          </div>

          {error && <div role="alert" className="mx-4 mb-3 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-800"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button></div>}
          {notice && <div role="status" className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-xs text-emerald-800"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={14} /></button></div>}
          <form onSubmit={(event) => void sendMessage(event)} className="border-t border-slate-100 p-3 sm:p-4">
            <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2 focus-within:border-blue-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100">
              <textarea aria-label="Message the payment assistant" rows={1} maxLength={2000} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }} placeholder="Describe what you'd like to do…" className="max-h-32 min-h-10 flex-1 resize-y bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400" />
              <button type="submit" disabled={!input.trim() || busy} aria-label="Send message" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-electric text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"><ArrowUp size={18} /></button>
            </div>
            <p className="mt-2 text-center text-[10px] text-slate-400">Review every proposed change before confirming. Payments are never sent.</p>
          </form>
        </section>

        <aside className="space-y-5">
          <Link to="/scan-pay" className="flex items-center justify-between rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm font-semibold text-blue-950 hover:bg-blue-100">
            <span className="flex items-center gap-2"><ShieldCheck size={17} /> Scan &amp; review a UPI QR</span>
            <span aria-hidden="true">→</span>
          </Link>
          {proposal && (
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card" aria-label="Review proposed action">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div><p className="text-[10px] font-semibold uppercase tracking-wide text-electric">Review before saving</p><h3 className="mt-1 text-sm font-semibold text-slate-900">{actionTitle(proposal.action)}</h3></div>
                <button aria-label="Dismiss proposal" onClick={() => setProposal(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
              </div>
              <div className="space-y-3">
                {proposal.action === 'prepare_universal_payment' && (
                  <>
                    <label className="block text-xs font-medium text-slate-600">Saved recipient
                      <select value={proposal.recipient_id ?? ''} onChange={(event) => {
                        const selected = recipients.find((recipient) => recipient.id === event.target.value)
                        updateProposal('recipient_id', selected?.id ?? null)
                        if (selected) updateProposal('recipient', selected.name)
                      }} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                        <option value="">Select a saved recipient</option>
                        {recipients.map((recipient) => (
                          <option key={recipient.id} value={recipient.id}>
                            {recipient.name} · {recipient.identifier}{recipient.is_verified ? '' : ' · unverified'}
                          </option>
                        ))}
                      </select>
                      {recipients.length === 0 && <span className="mt-1 block text-[11px] text-amber-700">Add a recipient in Payments before preparing a transfer.</span>}
                    </label>
                    <label className="block text-xs font-medium text-slate-600">Payment category
                      <select value={proposal.payment_category ?? ''} onChange={(event) => updateProposal('payment_category', (event.target.value || null) as UniversalCategory | null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                        <option value="">Select category</option>
                        <option value="person_to_person">Person-to-person</option>
                        <option value="merchant">Merchant / shopping</option>
                        <option value="qr_payment">QR / UPI request</option>
                        <option value="scheduled_transfer">Scheduled transfer</option>
                        <option value="account_transfer">Account transfer</option>
                        <option value="utility_bill">Utility bill</option>
                        <option value="invoice">Invoice</option>
                        <option value="subscription">Subscription</option>
                        <option value="everyday">Everyday payment</option>
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs font-medium text-slate-600">Amount
                        <input type="number" min="0.01" step="0.01" value={proposal.amount ?? ''} onChange={(event) => updateProposal('amount', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">Currency
                        <select value={proposal.currency ?? ''} onChange={(event) => updateProposal('currency', (event.target.value || null) as Currency | null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                          <option value="">Select currency</option><option value="INR">INR · ₹</option><option value="USD">USD · $</option>
                        </select>
                      </label>
                    </div>
                    <label className="block text-xs font-medium text-slate-600">Purpose
                      <input maxLength={300} value={proposal.purpose ?? ''} onChange={(event) => updateProposal('purpose', event.target.value || null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                    </label>
                    <label className="block text-xs font-medium text-slate-600">Payment date
                      <input type="date" value={proposal.payment_date ?? ''} onChange={(event) => updateProposal('payment_date', event.target.value || null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                    </label>
                    {proposal.payment_category === 'qr_payment' && (
                      <label className="block text-xs font-medium text-slate-600">Decoded UPI ID
                        <input required maxLength={320} value={proposal.qr_recipient_identifier ?? ''} onChange={(event) => updateProposal('qr_recipient_identifier', event.target.value || null)} placeholder="Scan the QR in Scan & Pay first" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                      </label>
                    )}
                    {proposal.payment_category === 'merchant' && (
                      <label className="block text-xs font-medium text-slate-600">Order / purchase reference
                        <input maxLength={160} value={proposal.order_reference ?? ''} onChange={(event) => updateProposal('order_reference', event.target.value || null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                      </label>
                    )}
                    {['scheduled_transfer', 'subscription'].includes(proposal.payment_category ?? '') && (
                      <label className="block text-xs font-medium text-slate-600">Recurrence
                        <select value={proposal.recurrence ?? ''} onChange={(event) => updateProposal('recurrence', (event.target.value || null) as PaymentFrequency | null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                          <option value="">Select recurrence</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                        </select>
                      </label>
                    )}
                    {proposal.risk && (
                      <div className={`rounded-xl border p-3 ${proposal.risk.level === 'High' ? 'border-rose-200 bg-rose-50' : proposal.risk.level === 'Medium' ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                        <p className="text-xs font-semibold text-slate-800">{proposal.risk.level} risk · {proposal.risk.score}/100</p>
                        <p className="mt-1 text-[11px] text-slate-600">{proposal.risk.recommended_action}</p>
                        {proposal.risk.evidence.length > 0 && <ul className="mt-2 list-inside list-disc space-y-1 text-[11px] text-slate-600">{proposal.risk.evidence.map((item, index) => <li key={`${item.type}-${index}`}>{item.type.replace(/_/g, ' ')} (+{item.points}){item.details ? `: ${typeof item.details === 'string' ? item.details : JSON.stringify(item.details)}` : ''}</li>)}</ul>}
                        {proposal.risk.duplicate_blocked && <p className="mt-2 text-[11px] font-medium text-rose-800">An exact duplicate is already recorded; this request cannot be prepared.</p>}
                      </div>
                    )}
                    {riskChecking && <p className="flex items-center gap-2 text-xs text-slate-500"><LoaderCircle size={14} className="animate-spin" />Checking payment risk…</p>}
                  </>
                )}
                {(proposal.action === 'create_payment_rule' || proposal.action === 'set_payment_limit' || proposal.action === 'set_bill_reminder') && (
                  <label className="block text-xs font-medium text-slate-600">Recipient / provider
                    <input value={proposal.recipient ?? ''} readOnly={proposal.action === 'set_payment_limit' || proposal.action === 'set_bill_reminder'} onChange={(event) => updateProposal('recipient', event.target.value || null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 read-only:bg-slate-50" />
                  </label>
                )}
                {proposal.action === 'create_payment_rule' && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs font-medium text-slate-600">Amount
                        <input type="number" min="0.01" step="0.01" value={proposal.amount ?? ''} onChange={(event) => updateProposal('amount', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">Maximum limit
                        <input type="number" min="0.01" step="0.01" value={proposal.maximum_limit ?? ''} onChange={(event) => updateProposal('maximum_limit', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs font-medium text-slate-600">Currency
                        <select value={proposal.currency ?? ''} onChange={(event) => updateProposal('currency', (event.target.value || null) as Currency | null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                          <option value="">Choose currency</option><option value="INR">INR · ₹</option><option value="USD">USD · $</option>
                        </select>
                      </label>
                      <label className="text-xs font-medium text-slate-600">Frequency
                        <select value={proposal.frequency ?? ''} onChange={(event) => updateProposal('frequency', (event.target.value || null) as PaymentFrequency | null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                          <option value="">Choose</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                        </select>
                      </label>
                    </div>
                    <label className="block text-xs font-medium text-slate-600">{proposal.frequency === 'weekly' ? 'Payment weekday' : 'Payment day'}
                      {proposal.frequency === 'weekly' ? (
                        <select value={proposal.payment_day ?? ''} onChange={(event) => updateProposal('payment_day', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                          <option value="">Choose weekday</option>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                        </select>
                      ) : <input type="number" min="1" max="31" value={proposal.payment_day ?? ''} onChange={(event) => updateProposal('payment_day', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />}
                    </label>
                    <label className="block text-xs font-medium text-slate-600">Start date
                      <input type="date" value={proposal.start_date ?? ''} onChange={(event) => updateProposal('start_date', event.target.value || null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                    </label>
                  </>
                )}
                {proposal.action === 'set_payment_limit' && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs font-medium text-slate-600">New maximum limit
                      <input type="number" min="0.01" step="0.01" value={proposal.maximum_limit ?? ''} onChange={(event) => updateProposal('maximum_limit', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">Rule currency
                      <input value={proposal.currency ?? ''} readOnly className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-normal text-slate-800" />
                    </label>
                  </div>
                )}
                {proposal.action === 'pause_payment_rule' || proposal.action === 'resume_payment_rule' ? (
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-sm font-medium text-slate-800">{proposal.recipient}</p>
                    <p className="mt-1 text-xs text-slate-500">{proposal.action === 'pause_payment_rule' ? 'This stops future scheduled entries. No payment will be sent.' : 'This restores future scheduled entries. Each still needs approval.'}</p>
                  </div>
                ) : null}
                {proposal.action === 'set_bill_reminder' && (
                  <>
                    <label className="block text-xs font-medium text-slate-600">Bill due date
                      <input type="date" value={proposal.reminder_due_date ?? ''} onChange={(event) => updateProposal('reminder_due_date', event.target.value || null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs font-medium text-slate-600">Amount (optional)
                        <input type="number" min="0.01" step="0.01" value={proposal.amount ?? ''} onChange={(event) => updateProposal('amount', event.target.value ? Number(event.target.value) : null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">Currency (optional)
                        <select value={proposal.currency ?? ''} onChange={(event) => updateProposal('currency', (event.target.value || null) as Currency | null)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                          <option value="">Not specified</option><option value="INR">INR · ₹</option><option value="USD">USD · $</option>
                        </select>
                      </label>
                    </div>
                  </>
                )}
              </div>

              {missing.length > 0 && (
                <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0" />Still needed: {missing.map(fieldLabel).join(', ')}. Continue in chat to provide missing details.</p>
              )}
              <button disabled={missing.length > 0 || confirming || riskChecking || (proposal.action === 'prepare_universal_payment' && (!proposal.risk || proposal.risk.duplicate_blocked))} onClick={() => void confirmProposal()} className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-electric px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {confirming ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}
                {confirming ? 'Saving…' : proposal.action === 'prepare_universal_payment' ? 'Confirm and prepare request' : `Confirm ${proposal.action === 'create_payment_rule' ? 'rule' : proposal.action === 'set_bill_reminder' ? 'reminder' : 'change'}`}
              </button>
              <p className="mt-2 text-center text-[10px] leading-relaxed text-slate-400">{proposal.action === 'prepare_universal_payment' ? 'This creates a prepared request only. You must separately review and approve sandbox execution in Payments.' : 'Confirmation authorizes this change only. It never authorizes or initiates a payment.'}</p>
            </section>
          )}

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
            <h3 className="text-xs font-semibold text-slate-800">Try asking</h3>
            <div className="mt-3 space-y-2">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} disabled={busy} onClick={() => void sendMessage(undefined, suggestion)} className="w-full rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5 text-left text-xs leading-relaxed text-slate-600 transition hover:border-blue-100 hover:bg-blue-50/60 hover:text-blue-800 disabled:opacity-50">{suggestion}</button>
              ))}
            </div>
          </section>

          <div className="flex items-start gap-2.5 rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-[11px] leading-relaxed text-blue-900/75">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-electric" />
            AI prepares a validated preview only. Review every field; rule changes require your confirmation, and payments always require separate approval.
          </div>
        </aside>
      </div>
    </div>
  )
}

export default Assistant
