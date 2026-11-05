import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import {
  AlertTriangle, CalendarDays, CheckCircle2, Clock3, LoaderCircle,
  Pause, Pencil, Play, Plus, ShieldCheck, Trash2, X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatCurrency } from './payment-format'
import { apiFetch } from './api-client'

type PaymentRule = {
  id: string
  recipient: string
  amount: number
  maximum_limit: number
  currency: 'USD' | 'INR'
  frequency: 'weekly' | 'monthly'
  payment_date: number
  start_date: string
  is_active: boolean
  details_changed: boolean
  recipient_changed: boolean
}

type ScheduledPayment = {
  rule_id: string
  recipient: string
  amount: number
  maximum_limit: number
  currency: 'USD' | 'INR'
  frequency: 'weekly' | 'monthly'
  payment_date: string
  status: 'pending_approval' | 'overdue'
  requires_approval: true
  exceeds_limit: boolean
  details_changed: boolean
  recipient_changed: boolean
}

type PaymentRequestRecord = {
  id: string
  bill_id: string
  recipient: string
  amount: number
  currency: 'USD' | 'INR'
  status: 'prepared' | 'pending' | 'succeeded' | 'failed'
  error_code: string | null
  error_message: string | null
  provider_reference: string | null
  execution_mode: 'sandbox'
}

type PaymentRecovery = {
  events: { previous_status: string | null; new_status: string; detail: string; created_at: string }[]
  recommended_action: string
}

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

type UniversalPaymentMethod = 'sandbox_simulator' | 'upi_qr' | 'bank_transfer' | 'card'

type PaymentRecipient = {
  id: string
  name: string
  recipient_type: 'person' | 'merchant' | 'bank_account' | 'utility' | 'service' | 'other'
  identifier: string
  account_reference: string | null
  is_verified: boolean
  details_changed: boolean
}

type UniversalPaymentRecord = {
  id: string
  category: UniversalCategory
  recipient_id: string
  recipient: string
  amount: number
  currency: 'USD' | 'INR'
  payment_method: UniversalPaymentMethod
  purpose: string
  payment_date: string
  order_reference: string | null
  qr_recipient_identifier: string | null
  qr_amount: number | null
  qr_payee_name: string | null
  qr_merchant_code: string | null
  qr_transaction_reference: string | null
  recurrence: 'weekly' | 'monthly' | null
  approval_status: 'awaiting_approval' | 'approved' | 'cancelled'
  status: 'prepared' | 'pending' | 'succeeded' | 'failed' | 'refunded'
  risk: { level: 'Low' | 'Medium' | 'High'; score: number; evidence: { type: string; points: number; details?: unknown }[] }
  error_code: string | null
  error_message: string | null
  provider_reference: string | null
}

type UniversalRisk = {
  level: 'Low' | 'Medium' | 'High'
  score: number
  evidence: { type: string; points: number; details?: unknown }[]
  recommended_action: string
  duplicate_blocked: boolean
}

type RuleForm = {
  recipient: string
  amount: string
  maximum_limit: string
  currency: 'USD' | 'INR'
  frequency: 'weekly' | 'monthly'
  payment_date: string
  start_date: string
}

const today = () => {
  const current = new Date()
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`
}
const emptyForm = (): RuleForm => ({
  recipient: '',
  amount: '',
  maximum_limit: '',
  currency: 'USD',
  frequency: 'monthly',
  payment_date: '1',
  start_date: today(),
})

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json() as { detail?: string }
      if (body.detail) message = body.detail
    } catch {
      // Keep the HTTP status message when the server does not return JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function frequencyLabel(rule: Pick<PaymentRule, 'frequency' | 'payment_date'>) {
  if (rule.frequency === 'monthly') return `Monthly · day ${rule.payment_date}`
  return `Weekly · ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][rule.payment_date - 1]}`
}

function formatRiskDetails(details: unknown): string {
  if (typeof details === 'string') return details
  if (details === undefined || details === null) return ''
  return JSON.stringify(details) ?? String(details)
}

function Payments() {
  const [rules, setRules] = useState<PaymentRule[]>([])
  const [schedule, setSchedule] = useState<ScheduledPayment[]>([])
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequestRecord[]>([])
  const [recipients, setRecipients] = useState<PaymentRecipient[]>([])
  const [universalPayments, setUniversalPayments] = useState<UniversalPaymentRecord[]>([])
  const [recovery, setRecovery] = useState<Record<string, PaymentRecovery>>({})
  const [universalCategory, setUniversalCategory] = useState<UniversalCategory>('person_to_person')
  const [universalMethod, setUniversalMethod] = useState<UniversalPaymentMethod>('sandbox_simulator')
  const [universalRecipientId, setUniversalRecipientId] = useState('')
  const [universalAmount, setUniversalAmount] = useState('')
  const [universalCurrency, setUniversalCurrency] = useState<'USD' | 'INR'>('INR')
  const [universalPurpose, setUniversalPurpose] = useState('')
  const [universalDate, setUniversalDate] = useState(today())
  const [universalOrderReference, setUniversalOrderReference] = useState('')
  const [qrRecipientIdentifier, setQrRecipientIdentifier] = useState<string | null>(null)
  const [qrAmount, setQrAmount] = useState<number | null>(null)
  const [qrPayeeName, setQrPayeeName] = useState<string | null>(null)
  const [qrMerchantCode, setQrMerchantCode] = useState<string | null>(null)
  const [qrTransactionReference, setQrTransactionReference] = useState<string | null>(null)
  const [universalRecurrence, setUniversalRecurrence] = useState<'weekly' | 'monthly'>('monthly')
  const [reviewUniversal, setReviewUniversal] = useState(false)
  const [editingUniversalId, setEditingUniversalId] = useState<string | null>(null)
  const [universalRisk, setUniversalRisk] = useState<UniversalRisk | null>(null)
  const [riskExplanations, setRiskExplanations] = useState<Record<string, string>>({})
  const [newRecipientOpen, setNewRecipientOpen] = useState(false)
  const [newRecipientName, setNewRecipientName] = useState('')
  const [newRecipientType, setNewRecipientType] = useState<PaymentRecipient['recipient_type']>('person')
  const [newRecipientIdentifier, setNewRecipientIdentifier] = useState('')
  const [newRecipientAccount, setNewRecipientAccount] = useState('')
  const [riskAcknowledged, setRiskAcknowledged] = useState<Record<string, boolean>>({})
  const [universalSaving, setUniversalSaving] = useState(false)
  const [form, setForm] = useState<RuleForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadPayments = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await request('/api/payment-requests/prepare-due', { method: 'POST' })
      const [savedRules, upcoming, requests] = await Promise.all([
        request<PaymentRule[]>('/api/payments/rules'),
        request<ScheduledPayment[]>('/api/payments/schedule'),
        request<PaymentRequestRecord[]>('/api/payment-requests'),
      ])
      const [savedRecipients, savedUniversalPayments] = await Promise.all([
        request<PaymentRecipient[]>('/api/payment-recipients'),
        request<UniversalPaymentRecord[]>('/api/universal-payment-requests'),
      ])
      setRules(savedRules)
      setSchedule(upcoming)
      setPaymentRequests(requests)
      setRecipients(savedRecipients)
      setUniversalPayments(savedUniversalPayments)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load payment rules.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPayments()
  }, [loadPayments])

  const selectedRecipient = recipients.find((recipient) => recipient.id === universalRecipientId) ?? null
  const needsOrderReference = universalCategory === 'merchant'
  const needsRecurrence = universalCategory === 'scheduled_transfer' || universalCategory === 'subscription'

  async function saveNewRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const created = await request<PaymentRecipient>('/api/payment-recipients', {
        method: 'POST',
        body: JSON.stringify({
          name: newRecipientName,
          recipient_type: newRecipientType,
          identifier: newRecipientIdentifier,
          account_reference: newRecipientAccount || null,
        }),
      })
      setRecipients((current) => [...current, created])
      setUniversalRecipientId(created.id)
      setNewRecipientOpen(false)
      setNewRecipientName('')
      setNewRecipientIdentifier('')
      setNewRecipientAccount('')
      setNotice('Recipient added, but not verified. Confirm the details before sandbox approval.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this recipient.')
    } finally {
      setSaving(false)
    }
  }

  async function verifySelectedRecipient() {
    if (!selectedRecipient) return
    setActionId(selectedRecipient.id)
    setError(null)
    try {
      const verified = await request<PaymentRecipient>(
        `/api/payment-recipients/${encodeURIComponent(selectedRecipient.id)}/verify`,
        { method: 'POST' },
      )
      setRecipients((current) => current.map((item) => item.id === verified.id ? verified : item))
      setNotice('You confirmed these recipient details. This is your attestation, not external bank verification.')
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'Could not confirm recipient details.')
    } finally {
      setActionId(null)
    }
  }

  function universalPaymentPayload() {
    return {
      recipient_id: universalRecipientId,
      category: universalCategory,
      payment_method: universalMethod,
      amount: Number(universalAmount),
      currency: universalCurrency,
      purpose: universalPurpose,
      payment_date: universalDate,
      order_reference: needsOrderReference ? universalOrderReference : null,
      recurrence: needsRecurrence ? universalRecurrence : null,
      qr_recipient_identifier: qrRecipientIdentifier,
      qr_amount: qrAmount,
      qr_payee_name: qrPayeeName,
      qr_merchant_code: qrMerchantCode,
      qr_transaction_reference: qrTransactionReference,
    }
  }

  async function assessUniversalPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setUniversalSaving(true)
    setError(null)
    setNotice(null)
    try {
      const risk = await request<UniversalRisk>('/api/universal-payment-risk', {
        method: 'POST',
        body: JSON.stringify(universalPaymentPayload()),
      })
      setUniversalRisk(risk)
      setReviewUniversal(true)
    } catch (assessmentError) {
      setError(assessmentError instanceof Error ? assessmentError.message : 'Could not assess this payment.')
    } finally {
      setUniversalSaving(false)
    }
  }

  async function scanQrFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const Detector = (window as Window & {
      BarcodeDetector?: new (options?: { formats: string[] }) => {
        detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>
      }
    }).BarcodeDetector
    if (!Detector) {
      setError('Local QR decoding is not supported by this browser. Use a recent Chromium browser or enter the saved recipient manually.')
      return
    }
    setError(null)
    try {
      const bitmap = await createImageBitmap(file)
      let rawValue: string | undefined
      try {
        const [barcode] = await new Detector({ formats: ['qr_code'] }).detect(bitmap)
        rawValue = barcode?.rawValue
      } finally {
        bitmap.close()
      }
      if (!rawValue) throw new Error('No QR code was found in that image.')
      const parsed = await request<{
        recipient_identifier: string
        recipient_name: string | null
        merchant_code: string | null
        amount: number | null
        currency: 'USD' | 'INR'
        purpose: string
        order_reference: string | null
        transaction_reference: string | null
        upi_id_valid: boolean
        validation_warnings: string[]
        payment_initiated: false
      }>('/api/qr/parse', { method: 'POST', body: JSON.stringify({ payload: rawValue }) })
      if (!parsed.upi_id_valid || !parsed.recipient_identifier) {
        throw new Error(parsed.validation_warnings.join(' ') || 'The QR does not contain a valid UPI ID.')
      }
      const matchingRecipient = recipients.find(
        (item) => item.identifier.toLocaleLowerCase() === parsed.recipient_identifier.toLocaleLowerCase(),
      )
      setUniversalMethod('upi_qr')
      setQrRecipientIdentifier(parsed.recipient_identifier)
      setQrAmount(parsed.amount)
      setQrPayeeName(parsed.recipient_name)
      setQrMerchantCode(parsed.merchant_code)
      setQrTransactionReference(parsed.transaction_reference)
      setUniversalCurrency(parsed.currency)
      setUniversalPurpose(parsed.purpose)
      setUniversalOrderReference(parsed.order_reference ?? '')
      if (parsed.amount !== null && !universalAmount) setUniversalAmount(String(parsed.amount))
      if (matchingRecipient) {
        setUniversalRecipientId(matchingRecipient.id)
      } else {
        setNewRecipientName(parsed.recipient_name ?? '')
        setNewRecipientType('merchant')
        setNewRecipientIdentifier(parsed.recipient_identifier)
        setNewRecipientAccount('')
        setNewRecipientOpen(true)
        setNotice('QR details were decoded locally. Review the payee and save it as an unverified recipient.')
      }
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Could not read payment QR details.')
    }
  }

  async function prepareUniversalPayment() {
    if (!selectedRecipient) return
    setUniversalSaving(true)
    setError(null)
    setNotice(null)
    setRiskAcknowledged({})
    try {
      const saved = await request<UniversalPaymentRecord>(
        editingUniversalId
          ? `/api/universal-payment-requests/${encodeURIComponent(editingUniversalId)}`
          : '/api/universal-payment-requests',
        {
        method: editingUniversalId ? 'PUT' : 'POST',
        ...(!editingUniversalId ? { headers: { 'Idempotency-Key': crypto.randomUUID() } } : {}),
        body: JSON.stringify(universalPaymentPayload()),
      })
      setUniversalPayments((current) => editingUniversalId
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...current])
      setReviewUniversal(false)
      setUniversalRisk(null)
      setEditingUniversalId(null)
      setNotice(editingUniversalId
        ? 'Prepared payment request updated. It still requires separate approval.'
        : 'Payment request prepared. It is not sent; use the separate sandbox approval after review.')
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : 'Could not prepare this payment request.')
    } finally {
      setUniversalSaving(false)
    }
  }

  function startEditUniversalPayment(payment: UniversalPaymentRecord) {
    setEditingUniversalId(payment.id)
    setUniversalCategory(payment.category)
    setUniversalMethod(payment.payment_method)
    setUniversalRecipientId(payment.recipient_id)
    setUniversalAmount(String(payment.amount))
    setUniversalCurrency(payment.currency)
    setUniversalPurpose(payment.purpose)
    setUniversalDate(payment.payment_date)
    setUniversalOrderReference(payment.order_reference ?? '')
    setQrRecipientIdentifier(payment.qr_recipient_identifier)
    setQrAmount(payment.qr_amount)
    setQrPayeeName(payment.qr_payee_name)
    setQrMerchantCode(payment.qr_merchant_code)
    setQrTransactionReference(payment.qr_transaction_reference)
    setUniversalRecurrence(payment.recurrence ?? 'monthly')
    setReviewUniversal(false)
    setUniversalRisk(null)
    setError(null)
    setNotice('Editing a prepared request does not approve or submit it.')
  }

  async function cancelUniversalPayment(payment: UniversalPaymentRecord) {
    if (!window.confirm(`Cancel the unapproved payment request for ${payment.recipient}?`)) return
    setActionId(payment.id)
    setError(null)
    setNotice(null)
    try {
      await request<void>(`/api/universal-payment-requests/${encodeURIComponent(payment.id)}`, {
        method: 'DELETE',
      })
      setUniversalPayments((current) => current.map((item) => item.id === payment.id
        ? { ...item, approval_status: 'cancelled' }
        : item))
      setNotice('Request cancelled before approval. Its audit history was retained.')
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Could not cancel this payment request.')
    } finally {
      setActionId(null)
    }
  }

  async function explainUniversalRisk(payment: UniversalPaymentRecord) {
    setActionId(payment.id)
    setError(null)
    try {
      const explanation = await request<{ explanation: string; recommended_action: string }>(
        `/api/universal-payment-requests/${encodeURIComponent(payment.id)}/risk/explanation`,
        { method: 'POST' },
      )
      setRiskExplanations((current) => ({
        ...current,
        [payment.id]: `${explanation.explanation} ${explanation.recommended_action}`,
      }))
    } catch (explanationError) {
      setError(explanationError instanceof Error ? explanationError.message : 'Could not explain payment risk.')
    } finally {
      setActionId(null)
    }
  }

  async function approveUniversalPayment(payment: UniversalPaymentRecord) {
    setActionId(payment.id)
    setError(null)
    setNotice(null)
    try {
      const updated = await request<UniversalPaymentRecord>(
        `/api/universal-payment-requests/${encodeURIComponent(payment.id)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirm_sandbox_payment: true,
            acknowledge_high_risk: riskAcknowledged[payment.id] ?? false,
          }),
        },
      )
      setUniversalPayments((current) => current.map((item) => item.id === updated.id ? updated : item))
      setRiskAcknowledged((current) => ({ ...current, [payment.id]: false }))
      setNotice(`Sandbox result: ${updated.status}. No live payment provider was contacted.`)
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : 'Could not approve this sandbox request.')
    } finally {
      setActionId(null)
    }
  }

  async function refundUniversalPayment(payment: UniversalPaymentRecord) {
    const reason = window.prompt('Reason for this simulated sandbox refund:')
    if (!reason?.trim()) return
    setActionId(payment.id)
    setError(null)
    try {
      const updated = await request<UniversalPaymentRecord>(
        `/api/universal-payment-requests/${encodeURIComponent(payment.id)}/refund`,
        {
          method: 'POST',
          body: JSON.stringify({ confirm_sandbox_refund: true, reason: reason.trim() }),
        },
      )
      setUniversalPayments((current) => current.map((item) => item.id === updated.id ? updated : item))
      setNotice('Sandbox refund status recorded. No provider refund was sent.')
    } catch (refundError) {
      setError(refundError instanceof Error ? refundError.message : 'Could not record sandbox refund.')
    } finally {
      setActionId(null)
    }
  }

  function startCreate() {
    setEditingId(null)
    setForm(emptyForm())
    setFormOpen(true)
    setError(null)
    setNotice(null)
  }

  function startEdit(rule: PaymentRule) {
    setEditingId(rule.id)
    setForm({
      recipient: rule.recipient,
      amount: String(rule.amount),
      maximum_limit: String(rule.maximum_limit),
      currency: rule.currency,
      frequency: rule.frequency,
      payment_date: String(rule.payment_date),
      start_date: rule.start_date,
    })
    setFormOpen(true)
    setError(null)
    setNotice(null)
  }

  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    const body = {
      ...form,
      amount: Number(form.amount),
      maximum_limit: Number(form.maximum_limit),
      currency: form.currency,
      payment_date: Number(form.payment_date),
    }
    try {
      await request<PaymentRule>(
        editingId ? `/api/payments/rules/${editingId}` : '/api/payments/rules',
        { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body) },
      )
      setFormOpen(false)
      setNotice(editingId ? 'Payment rule updated.' : 'Payment rule created.')
      await loadPayments()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this payment rule.')
    } finally {
      setSaving(false)
    }
  }

  async function toggleRule(rule: PaymentRule) {
    setActionId(rule.id)
    setError(null)
    setNotice(null)
    try {
      await request<PaymentRule>(
        `/api/payments/rules/${rule.id}/status?is_active=${!rule.is_active}`,
        { method: 'PATCH' },
      )
      setNotice(rule.is_active ? 'Payment rule paused.' : 'Payment rule resumed.')
      await loadPayments()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update this payment rule.')
    } finally {
      setActionId(null)
    }
  }

  async function deleteRule(rule: PaymentRule) {
    if (!window.confirm(`Delete the recurring rule for ${rule.recipient}?`)) return
    setActionId(rule.id)
    setError(null)
    setNotice(null)
    try {
      await request<void>(`/api/payments/rules/${rule.id}`, { method: 'DELETE' })
      setNotice('Payment rule deleted.')
      await loadPayments()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not delete this payment rule.')
    } finally {
      setActionId(null)
    }
  }

  async function loadRecovery(paymentId: string) {
    setActionId(paymentId)
    setError(null)
    try {
      const details = await request<PaymentRecovery>(`/api/payment-requests/${paymentId}/recovery`)
      setRecovery((current) => ({ ...current, [paymentId]: details }))
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : 'Could not load recovery details.')
    } finally {
      setActionId(null)
    }
  }

  async function createSupportRequest(paymentId: string) {
    setActionId(paymentId)
    setError(null)
    setNotice(null)
    try {
      await request(`/api/payment-requests/${paymentId}/support`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNotice('Support request created for the payment provider team. No retry was initiated.')
    } catch (supportError) {
      setError(supportError instanceof Error ? supportError.message : 'Could not create a support request.')
    } finally {
      setActionId(null)
    }
  }

  const upcoming = schedule.slice(0, 8)

  return (
    <div className="page-enter space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-slate-500">Recurring payment schedules · no transfers are made</p>
          <h2 className="mt-1 text-[25px] font-semibold tracking-tight text-slate-900">Payment rules</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Save recurring rules to prepare calendar previews. These are not payment requests and are never sent.</p>
        </div>
        <button onClick={startCreate} className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-xl bg-electric px-4 text-sm font-medium text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700 sm:self-auto">
          <Plus size={17} /> Create Payment Rule
        </button>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
        <ShieldCheck size={19} className="mt-0.5 shrink-0 text-electric" />
        <div>
          <p className="text-sm font-semibold text-blue-950">Rules do not execute payments</p>
          <p className="mt-1 text-xs leading-relaxed text-blue-900/70">Schedule entries are previews generated from saved rules, not payment requests. No real payment provider is connected; any approval in the bill workflow records a sandbox result only.</p>
        </div>
      </div>

      {error && <div role="alert" className="flex items-start justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={16} /></button></div>}
      {notice && <div role="status" className="flex items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}

      <section className="space-y-5 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-medium text-electric">Sandbox only · no bank or merchant is contacted</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">Universal payment request</h2>
            <p className="mt-1 text-xs text-slate-500">Prepare transfers, purchases, QR requests, bills, subscriptions, and scheduled payments. Review first; approve separately.</p>
          </div>
          <label className="inline-flex cursor-pointer items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Scan QR image locally
            <input aria-label="Scan QR image locally" className="sr-only" type="file" accept="image/*" onChange={(event) => void scanQrFile(event)} />
          </label>
          <Link to={`/scan-pay?category=${encodeURIComponent(universalCategory)}&amount=${encodeURIComponent(universalAmount)}`} className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">Open Scan &amp; Pay protection</Link>
        </div>

        <form onSubmit={(event) => void assessUniversalPayment(event)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs font-medium text-slate-600">Payment category
            <select required value={universalCategory} onChange={(event) => {
              const nextCategory = event.target.value as UniversalCategory
              setUniversalCategory(nextCategory)
              if (nextCategory !== 'qr_payment' || universalCategory !== 'qr_payment') {
                setQrRecipientIdentifier(null)
                setQrAmount(null)
              }
              setReviewUniversal(false)
              setUniversalRisk(null)
            }} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
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

          <label className="text-xs font-medium text-slate-600">Payment method · simulated only
            <select required value={universalMethod} onChange={(event) => {
              setUniversalMethod(event.target.value as UniversalPaymentMethod)
              setReviewUniversal(false)
              setUniversalRisk(null)
            }} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
              <option value="sandbox_simulator">Sandbox simulator</option>
              <option value="upi_qr">UPI / QR request (not connected)</option>
              <option value="bank_transfer">Bank transfer style (not connected)</option>
              <option value="card">Card-style purchase (not connected)</option>
            </select>
          </label>

          <label className="text-xs font-medium text-slate-600">Saved recipient
            <select required value={universalRecipientId} onChange={(event) => setUniversalRecipientId(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
              <option value="">Choose a recipient</option>
              {recipients.map((recipient) => (
                <option key={recipient.id} value={recipient.id}>
                  {recipient.name} · {recipient.identifier}{recipient.is_verified ? ' · confirmed' : ' · unverified'}
                </option>
              ))}
            </select>
          </label>

          <button type="button" onClick={() => setNewRecipientOpen((open) => !open)} className="self-end rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            {newRecipientOpen ? 'Close recipient form' : 'Add recipient'}
          </button>

          <label className="text-xs font-medium text-slate-600">Amount
            <input required type="number" min="0.01" step="0.01" value={universalAmount} onChange={(event) => setUniversalAmount(event.target.value)} placeholder="0.00" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
          </label>
          <label className="text-xs font-medium text-slate-600">Currency
            <select value={universalCurrency} onChange={(event) => setUniversalCurrency(event.target.value as 'USD' | 'INR')} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
              <option value="INR">INR · ₹</option><option value="USD">USD · $</option>
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">Payment date
            <input required type="date" value={universalDate} onChange={(event) => setUniversalDate(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">Purpose
            <input required maxLength={300} value={universalPurpose} onChange={(event) => setUniversalPurpose(event.target.value)} placeholder="What is this payment for?" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
          </label>
          {needsOrderReference && <label className="text-xs font-medium text-slate-600">Order / purchase reference
            <input required maxLength={160} value={universalOrderReference} onChange={(event) => setUniversalOrderReference(event.target.value)} placeholder="Merchant order reference" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
          </label>}
          {needsRecurrence && <label className="text-xs font-medium text-slate-600">Recurrence
            <select value={universalRecurrence} onChange={(event) => setUniversalRecurrence(event.target.value as 'weekly' | 'monthly')} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
              <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
          </label>}

          {qrRecipientIdentifier && (
            <div className={`rounded-xl p-3 text-xs sm:col-span-2 lg:col-span-3 ${
              (selectedRecipient && selectedRecipient.identifier.toLocaleLowerCase() !== qrRecipientIdentifier.toLocaleLowerCase())
              || (qrAmount !== null && Number(universalAmount) !== qrAmount)
                ? 'border border-amber-200 bg-amber-50 text-amber-900'
                : 'border border-slate-200 bg-slate-50 text-slate-700'
            }`}>
              <p className="font-semibold">QR details decoded locally · no payment initiated</p>
              <p className="mt-1">Encoded recipient: {qrRecipientIdentifier}{qrAmount !== null ? ` · encoded amount: ${formatCurrency(qrAmount, universalCurrency)}` : ' · no amount encoded'}{qrPayeeName ? ` · ${qrPayeeName}` : ''}{qrMerchantCode ? ` · merchant code ${qrMerchantCode}` : ''}</p>
              {qrTransactionReference && <p className="mt-1">Transaction reference: {qrTransactionReference}</p>}
              {selectedRecipient && selectedRecipient.identifier.toLocaleLowerCase() !== qrRecipientIdentifier.toLocaleLowerCase()
                && <p className="mt-1 font-semibold">Warning: the selected recipient differs from the QR recipient.</p>}
              {qrAmount !== null && Number(universalAmount) !== qrAmount
                && <p className="mt-1 font-semibold">Warning: the entered amount differs from the QR amount.</p>}
            </div>
          )}

          {selectedRecipient && (
            <div className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs sm:col-span-2 lg:col-span-3 ${selectedRecipient.is_verified && !selectedRecipient.details_changed ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
              <span>{selectedRecipient.details_changed ? 'Recipient details changed; re-confirm before approval.' : selectedRecipient.is_verified ? 'Recipient details user-confirmed; this is not external verification.' : 'Recipient is unconfirmed. Verify details before approval.'}</span>
              {(!selectedRecipient.is_verified || selectedRecipient.details_changed) && <button type="button" disabled={actionId === selectedRecipient.id} onClick={() => void verifySelectedRecipient()} className="shrink-0 rounded-lg border border-current px-2.5 py-1.5 font-medium disabled:opacity-50">I confirm details</button>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
            <button disabled={universalSaving || !recipients.length} type="submit" className="inline-flex h-10 items-center gap-2 rounded-xl bg-electric px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              {universalSaving && <LoaderCircle size={15} className="animate-spin" />} Review payment
            </button>
            <span className="text-[11px] text-slate-500">Review shows deterministic risk evidence before a request is saved.</span>
          </div>
        </form>

        {newRecipientOpen && <form onSubmit={(event) => void saveNewRecipient(event)} className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-slate-600">Recipient name<input required maxLength={160} value={newRecipientName} onChange={(event) => setNewRecipientName(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal" /></label>
          <label className="text-xs font-medium text-slate-600">Recipient type<select value={newRecipientType} onChange={(event) => setNewRecipientType(event.target.value as PaymentRecipient['recipient_type'])} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal"><option value="person">Person</option><option value="merchant">Merchant</option><option value="bank_account">Bank account</option><option value="utility">Utility</option><option value="service">Service</option><option value="other">Other</option></select></label>
          <label className="text-xs font-medium text-slate-600">UPI / beneficiary identifier<input required maxLength={200} value={newRecipientIdentifier} onChange={(event) => setNewRecipientIdentifier(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal" /></label>
          <label className="text-xs font-medium text-slate-600">Account reference (optional)<input maxLength={160} value={newRecipientAccount} onChange={(event) => setNewRecipientAccount(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal" /></label>
          <p className="text-[11px] text-amber-800 sm:col-span-2 lg:col-span-4">A matching name does not prove legitimacy. New recipients stay unverified until you check and confirm the identifier.</p>
          <button disabled={saving} type="submit" className="h-10 rounded-xl border border-slate-300 bg-white px-4 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">Save unverified recipient</button>
        </form>}

        {reviewUniversal && universalRisk && selectedRecipient && (
          <div className="space-y-4 rounded-xl border border-blue-100 bg-blue-50/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-slate-900">Review payment details</p>
                <p className="mt-1 text-xs text-slate-600">{selectedRecipient.name} · {selectedRecipient.identifier} · {formatCurrency(Number(universalAmount), universalCurrency)} · {universalDate}</p>
                <p className="mt-1 text-xs text-slate-600">{universalCategory.replace(/_/g, ' ')} · {universalMethod.replace(/_/g, ' ')} · {universalPurpose}{needsOrderReference ? ` · ${universalOrderReference}` : ''}{needsRecurrence ? ` · ${universalRecurrence}` : ''}</p>
                {universalCategory === 'qr_payment' && qrRecipientIdentifier && <p className="mt-1 text-xs text-amber-800">QR encoded recipient: {qrRecipientIdentifier}{qrAmount !== null ? ` · encoded amount: ${formatCurrency(qrAmount, universalCurrency)}` : ''}</p>}
              </div>
              <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${universalRisk.level === 'High' ? 'bg-rose-100 text-rose-800' : universalRisk.level === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                Risk {universalRisk.level} · {universalRisk.score}/100
              </span>
            </div>
            {universalRisk.evidence.length > 0 ? <ul className="space-y-1 text-xs text-slate-700">
              {universalRisk.evidence.map((item, index) => <li key={`${item.type}-${index}`}>{item.type.replace(/_/g, ' ')} · {item.points} points{item.details ? ` · ${formatRiskDetails(item.details)}` : ''}</li>)}
            </ul> : <p className="text-xs text-slate-600">No anomaly was detected from the available history. This does not guarantee safety.</p>}
            <p className="text-xs text-slate-600">{universalRisk.recommended_action}</p>
            {universalRisk.duplicate_blocked && <p role="alert" className="rounded-lg bg-rose-100 p-3 text-xs text-rose-800">A matching active or completed payment exists; this duplicate cannot be prepared.</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={universalSaving || universalRisk.duplicate_blocked} onClick={() => void prepareUniversalPayment()} className="h-10 rounded-xl bg-electric px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {universalSaving ? 'Saving…' : editingUniversalId ? 'Confirm changes to prepared request' : 'Confirm details and prepare request'}
              </button>
              <button type="button" onClick={() => setReviewUniversal(false)} className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-xs font-medium text-slate-700">Edit details</button>
              {editingUniversalId && <button type="button" onClick={() => { setEditingUniversalId(null); setReviewUniversal(false); setUniversalRisk(null) }} className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-xs font-medium text-slate-700">Stop editing</button>}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Universal payment request history</h3>
          {universalPayments.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">No universal payment requests yet.</p> : universalPayments.map((payment) => (
            <article key={payment.id} className="space-y-3 rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-sm font-semibold text-slate-800">{payment.recipient} · {payment.category.replace(/_/g, ' ')}</p><p className="mt-1 text-xs text-slate-500">{payment.payment_date} · {payment.purpose}{payment.order_reference ? ` · ${payment.order_reference}` : ''}</p></div>
                <div className="text-right"><p className="text-sm font-semibold text-slate-900">{formatCurrency(payment.amount, payment.currency)}</p><p className="mt-1 text-xs text-slate-500">Sandbox: {payment.status.replace(/_/g, ' ')} · approval: {payment.approval_status.replace(/_/g, ' ')} · {payment.risk.level} risk ({payment.risk.score})</p></div>
              </div>
              <p className="text-xs text-slate-500">Method: {payment.payment_method.replace(/_/g, ' ')} · simulation only</p>
              {payment.risk.evidence.length > 0 && <ul className="space-y-1 text-xs text-amber-800">{payment.risk.evidence.map((item, index) => <li key={`${payment.id}-${item.type}-${index}`}>{item.type.replace(/_/g, ' ')} · {item.points} points{item.details ? ` · ${formatRiskDetails(item.details)}` : ''}</li>)}</ul>}
              {riskExplanations[payment.id] && <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-900">{riskExplanations[payment.id]}</p>}
              {payment.error_message && <p className="text-xs text-rose-700">{payment.error_code}: {payment.error_message}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={actionId === payment.id} onClick={() => void explainUniversalRisk(payment)} className="text-xs font-medium text-electric hover:text-blue-700 disabled:opacity-50">Explain risk with BharatCode</button>
                {payment.status === 'prepared' && payment.approval_status === 'awaiting_approval' && (
                  <>
                    <button type="button" disabled={actionId === payment.id} onClick={() => startEditUniversalPayment(payment)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 disabled:opacity-50">Edit prepared request</button>
                    <button type="button" disabled={actionId === payment.id} onClick={() => void cancelUniversalPayment(payment)} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700 disabled:opacity-50">Cancel request</button>
                  </>
                )}
                {payment.status === 'prepared' && payment.approval_status === 'awaiting_approval' && (
                  !recipients.find((item) => item.id === payment.recipient_id)?.is_verified
                    ? <span className="text-xs text-amber-800">Confirm saved recipient before approval.</span>
                    : <>
                      {payment.risk.level === 'High' && <label className="flex items-center gap-2 text-xs text-rose-800"><input type="checkbox" checked={riskAcknowledged[payment.id] ?? false} onChange={(event) => setRiskAcknowledged((current) => ({ ...current, [payment.id]: event.target.checked }))} />I reviewed this high-risk evidence</label>}
                      <button type="button" disabled={actionId === payment.id || (payment.risk.level === 'High' && !(riskAcknowledged[payment.id] ?? false)) || payment.payment_date > today()} onClick={() => void approveUniversalPayment(payment)} className="rounded-lg bg-electric px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">Approve sandbox request</button>
                    </>
                )}
                {payment.approval_status === 'cancelled' && <span className="text-xs font-medium text-slate-500">Cancelled before approval; retained for audit.</span>}
                {payment.status === 'succeeded' && <button type="button" disabled={actionId === payment.id} onClick={() => void refundUniversalPayment(payment)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 disabled:opacity-50">Record sandbox refund</button>}
                {payment.status === 'succeeded' && <span className="text-[11px] text-slate-500">Sandbox result only; not a provider-confirmed payment.</span>}
              </div>
            </article>
          ))}
        </div>
      </section>

      {formOpen && (
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900">{editingId ? 'Edit payment rule' : 'Create payment rule'}</h3>
              <p className="mt-1 text-xs text-slate-500">Payments are never sent without your approval.</p>
            </div>
            <button type="button" aria-label="Close form" onClick={() => setFormOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
          </div>
          <form onSubmit={saveRule} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2 lg:col-span-1">Recipient / provider
              <input required maxLength={120} value={form.recipient} onChange={(event) => setForm({ ...form, recipient: event.target.value })} placeholder="e.g. Internet provider" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-xs font-medium text-slate-600">Amount
              <input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="0.00" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-xs font-medium text-slate-600">Currency
              <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value as RuleForm['currency'] })} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100">
                <option value="USD">USD · US Dollar</option><option value="INR">INR · Indian Rupee</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">Maximum payment limit
              <input required type="number" min="0.01" step="0.01" value={form.maximum_limit} onChange={(event) => setForm({ ...form, maximum_limit: event.target.value })} placeholder="0.00" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-xs font-medium text-slate-600">Frequency
              <select value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value as RuleForm['frequency'], payment_date: '1' })} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100">
                <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">{form.frequency === 'weekly' ? 'Payment day' : 'Payment date'}
              {form.frequency === 'weekly' ? (
                <select value={form.payment_date} onChange={(event) => setForm({ ...form, payment_date: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100">
                  {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                </select>
              ) : (
                <input required type="number" min="1" max="31" value={form.payment_date} onChange={(event) => setForm({ ...form, payment_date: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100" />
              )}
            </label>
            <label className="text-xs font-medium text-slate-600">Start date
              <input required type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100" />
            </label>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
              <button disabled={saving} type="submit" className="inline-flex h-10 items-center gap-2 rounded-xl bg-electric px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">
                {saving && <LoaderCircle size={16} className="animate-spin" />}{editingId ? 'Save changes' : 'Save rule'}
              </button>
              <button type="button" onClick={() => setFormOpen(false)} className="h-10 rounded-xl border border-slate-200 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
            </div>
          </form>
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="min-w-0 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <div><h3 className="text-sm font-semibold text-slate-900">Your payment rules</h3><p className="mt-1 text-xs text-slate-400">{rules.length} saved {rules.length === 1 ? 'rule' : 'rules'}</p></div>
            {loading && <LoaderCircle size={17} className="animate-spin text-slate-400" aria-label="Loading rules" />}
          </div>
          {loading && rules.length === 0 ? <div className="space-y-3" aria-label="Loading payment rules">{[0, 1, 2].map((item) => <div key={item} className="h-[82px] animate-pulse rounded-xl bg-slate-100" />)}</div> : rules.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center">
              <CalendarDays size={23} className="mx-auto text-slate-300" />
              <p className="mt-3 text-sm font-medium text-slate-700">No payment rules yet</p>
              <p className="mt-1 text-xs text-slate-400">Create a rule to see its schedule here.</p>
              <button onClick={startCreate} className="mt-4 text-xs font-semibold text-electric hover:text-blue-700">Create your first rule</button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {rules.map((rule) => (
                <article key={rule.id} className="flex flex-col gap-3 py-4 first:pt-1 sm:flex-row sm:items-center">
                  <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-semibold ${rule.is_active ? 'bg-blue-50 text-electric' : 'bg-slate-100 text-slate-400'}`}>{rule.recipient.slice(0, 1).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-semibold text-slate-800">{rule.recipient}</p><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${rule.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{rule.is_active ? 'Active' : 'Paused'}</span></div>
                    <p className="mt-1 text-xs text-slate-500">{frequencyLabel(rule)} <span className="px-1">·</span> Starts {formatDate(rule.start_date)}</p>
                    <p className="mt-1 text-[11px] text-slate-400">Limit {formatCurrency(rule.maximum_limit, rule.currency)}</p>
                    {(rule.details_changed || rule.recipient_changed) && <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle size={12} />{rule.recipient_changed ? 'Recipient changed' : 'Payment details changed'} · review upcoming payments</p>}
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <p className="text-sm font-semibold text-slate-900">{formatCurrency(rule.amount, rule.currency)}</p>
                    <div className="flex items-center gap-1">
                      <button title="Edit rule" aria-label={`Edit ${rule.recipient}`} onClick={() => startEdit(rule)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-electric"><Pencil size={15} /></button>
                      <button title={rule.is_active ? 'Pause rule' : 'Resume rule'} aria-label={`${rule.is_active ? 'Pause' : 'Resume'} ${rule.recipient}`} disabled={actionId === rule.id} onClick={() => void toggleRule(rule)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-electric disabled:opacity-50">{rule.is_active ? <Pause size={15} /> : <Play size={15} />}</button>
                      <button title="Delete rule" aria-label={`Delete ${rule.recipient}`} disabled={actionId === rule.id} onClick={() => void deleteRule(rule)} className="rounded-lg p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"><Trash2 size={15} /></button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4 flex items-start justify-between">
            <div><h3 className="text-sm font-semibold text-slate-900">Upcoming schedule</h3><p className="mt-1 text-xs text-slate-400">Next due dates · schedule preview only</p></div>
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-electric"><CalendarDays size={17} /></div>
          </div>
          {loading && schedule.length === 0 ? <div className="h-28 animate-pulse rounded-xl bg-slate-100" /> : upcoming.length === 0 ? (
            <div className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No scheduled entries. Active rule dates will appear here.</div>
          ) : (
            <div className="space-y-3">
              {upcoming.map((payment) => (
                <article key={`${payment.rule_id}-${payment.payment_date}`} className="rounded-xl border border-slate-100 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{payment.recipient}</p><p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><CalendarDays size={12} />{formatDate(payment.payment_date)}</p></div>
                    <p className="shrink-0 text-sm font-semibold text-slate-900">{formatCurrency(payment.amount, payment.currency)}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${payment.status === 'overdue' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                      {payment.status === 'overdue' ? <AlertTriangle size={11} /> : <Clock3 size={11} />}{payment.status === 'overdue' ? 'Due date passed' : 'Scheduled · not submitted'}
                    </span>
                    {payment.exceeds_limit && <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-1 text-[10px] font-medium text-rose-700"><AlertTriangle size={11} />Over limit</span>}
                    {payment.recipient_changed && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700">Recipient changed</span>}
                    {payment.details_changed && !payment.recipient_changed && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700">Details changed</span>}
                    {payment.requires_approval && <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700"><CheckCircle2 size={11} />Manual approval required if paid</span>}
                  </div>
                  {payment.exceeds_limit && <p className="mt-2 text-[11px] leading-relaxed text-rose-700">This amount exceeds the configured {formatCurrency(payment.maximum_limit, payment.currency)} limit. Check with the provider before making any payment.</p>}
                </article>
              ))}
            </div>
          )}
          {schedule.length > 8 && <p className="mt-3 text-center text-[11px] text-slate-400">Showing the next 8 of {schedule.length} scheduled payments</p>}
          <p className="mt-4 border-t border-slate-100 pt-4 text-[11px] leading-relaxed text-slate-400">These dates are generated from saved rules and do not represent initiated payments. Any payment must be arranged separately with the provider and explicitly approved.</p>
        </section>
      </div>
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-slate-900">Payment status and recovery</h3>
          <p className="mt-1 text-xs text-slate-500">Sandbox records only. Statuses are never presented as real provider confirmations.</p>
        </div>
        {paymentRequests.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No prepared payment requests.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {paymentRequests.map((payment) => (
              <article key={payment.id} className="space-y-2 py-4 first:pt-1 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-800">{payment.recipient} · {formatCurrency(payment.amount, payment.currency)}</p>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${payment.status === 'failed' ? 'bg-rose-50 text-rose-700' : payment.status === 'succeeded' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    {payment.status === 'succeeded' ? 'Sandbox success only' : payment.status === 'prepared' ? 'Prepared · not submitted' : payment.status}
                  </span>
                </div>
                {payment.error_message && <p className="text-xs text-rose-700">{payment.error_code}: {payment.error_message}</p>}
                <div className="flex flex-wrap gap-2">
                  <button disabled={actionId === payment.id} onClick={() => void loadRecovery(payment.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-700 disabled:opacity-50">
                    {recovery[payment.id] ? 'Refresh recovery details' : 'Check status and recovery'}
                  </button>
                  {(payment.status === 'failed' || payment.status === 'pending') && (
                    <button disabled={actionId === payment.id} onClick={() => void createSupportRequest(payment.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-700 disabled:opacity-50">Create support request</button>
                  )}
                </div>
                {recovery[payment.id] && (
                  <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
                    <p>{recovery[payment.id].recommended_action}</p>
                    <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
                      {recovery[payment.id].events.map((event, index) => <li key={`${event.new_status}-${index}`}>{event.created_at} · {event.previous_status ?? 'created'} → {event.new_status}: {event.detail}</li>)}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default Payments
