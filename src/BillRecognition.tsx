import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check, FileText, Image, LoaderCircle,
  RotateCcw, Sparkles, Upload, X,
} from 'lucide-react'
import { apiFetch } from './api-client'

type BillDetails = {
  provider: string
  customerName: string
  amount: string
  taxAmount: string
  currency: string
  billingDate: string
  dueDate: string
  invoiceNumber: string
  accountReference: string
  unitsConsumed: string
  billingPeriod: string
  documentType: 'utility_bill' | 'invoice' | 'receipt' | 'other' | ''
  missingFields: string[]
  uncertainFields: string[]
}

type BillRisk = {
  level: 'Low' | 'Medium' | 'High'
  score: number
  evidence: { type: string; points: number; details?: unknown; fields?: string[] }[]
  duplicates: { bill_id: string; type: 'exact' | 'possible'; reason: string }[]
  recommended_action: string
}

type SavedBill = {
  id: string
  provider_name: string | null
  customer_name: string | null
  bill_amount: number | null
  tax_amount: number | null
  currency: 'USD' | 'INR' | null
  billing_date: string | null
  due_date: string | null
  invoice_number: string | null
  account_reference: string | null
  units_consumed: string | null
  billing_period: string | null
  document_type: 'utility_bill' | 'invoice' | 'receipt' | 'other' | null
  created_at: string
  risk: BillRisk
}

type PaymentRequest = {
  id: string
  bill_id: string
  recipient: string
  amount: number
  currency: 'USD' | 'INR'
  status: 'prepared' | 'pending' | 'succeeded' | 'failed'
  error_code: string | null
  error_message: string | null
}

type ExtractionResponse = {
  provider_name: string | null
  customer_name: string | null
  bill_amount: number | null
  tax_amount: number | null
  currency: string | null
  billing_date: string | null
  due_date: string | null
  invoice_number: string | null
  account_reference: string | null
  units_consumed: string | null
  billing_period: string | null
  document_type: 'utility_bill' | 'invoice' | 'receipt' | 'other' | null
  missing_fields: string[]
  uncertain_fields: string[]
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const allowedTypes = new Map([
  ['pdf', ['application/pdf']],
  ['jpg', ['image/jpeg']],
  ['jpeg', ['image/jpeg']],
  ['png', ['image/png']],
])

function validateBillFile(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase()
  const matchingMimeTypes = extension ? allowedTypes.get(extension) : undefined

  if (!matchingMimeTypes || (file.type && !matchingMimeTypes.includes(file.type))) {
    return 'Choose a PDF, JPG, or PNG bill.'
  }
  if (file.size === 0) return 'This file is empty. Choose another bill.'
  if (file.size > MAX_FILE_SIZE) return 'Files must be 10 MB or smaller.'
  return null
}

function getErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const entries = payload as Record<string, unknown>
  if (typeof entries.detail === 'string' && entries.detail.trim()) return entries.detail.trim()
  if (Array.isArray(entries.detail)) {
    const messages = entries.detail
      .map((entry) => entry && typeof entry === 'object' && 'msg' in entry ? entry.msg : null)
      .filter((message): message is string => typeof message === 'string' && message.length > 0)
    if (messages.length) return messages.join(', ')
  }
  if (typeof entries.message === 'string' && entries.message.trim()) return entries.message.trim()
  if (typeof entries.error === 'string' && entries.error.trim()) return entries.error.trim()
  return null
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null

  const trimmed = text.trim()
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  if (!looksLikeJson) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

async function extractBillDetails(file: File): Promise<BillDetails> {
  const formData = new FormData()
  formData.append('file', file)

  let response: Response
  try {
    response = await apiFetch('/api/extract', { method: 'POST', body: formData })
  } catch (error) {
    throw new Error('Unable to reach the bill extraction service. Please check that the backend is running on port 8000.')
  }

  const payload = await readResponseBody(response)
  if (!response.ok) {
    const message = getErrorMessage(payload)
    if (message) {
      throw new Error(message)
    }

    const status = response.status ? ` (${response.status}${response.statusText ? ` ${response.statusText}` : ''})` : ''
    throw new Error(`Bill extraction failed${status}. Please try again.`)
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('The server returned an empty or invalid extraction response. Please try again.')
  }

  const extraction = payload as ExtractionResponse
  return {
    provider: extraction.provider_name ?? '',
    customerName: extraction.customer_name ?? '',
    amount: extraction.bill_amount === null ? '' : String(extraction.bill_amount),
    taxAmount: extraction.tax_amount === null ? '' : String(extraction.tax_amount),
    currency: ['INR', '₹', 'RS', 'RS.', 'RUPEE', 'RUPEES'].includes((extraction.currency ?? '').trim().toUpperCase())
      ? 'INR'
      : ['USD', '$', 'US$', 'US DOLLAR', 'US DOLLARS'].includes((extraction.currency ?? '').trim().toUpperCase())
        ? 'USD'
        : '',
    billingDate: extraction.billing_date ?? '',
    dueDate: extraction.due_date ?? '',
    invoiceNumber: extraction.invoice_number ?? '',
    accountReference: extraction.account_reference ?? '',
    unitsConsumed: extraction.units_consumed ?? '',
    billingPeriod: extraction.billing_period ?? '',
    documentType: extraction.document_type ?? '',
    missingFields: extraction.missing_fields ?? [],
    uncertainFields: extraction.uncertain_fields ?? [],
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, {
    ...init,
    headers: init?.body instanceof FormData
      ? init?.headers
      : { 'Content-Type': 'application/json', ...init?.headers },
  })
  const payload = await readResponseBody(response)
  if (!response.ok) {
    throw new Error(getErrorMessage(payload) ?? `Request failed (${response.status})`)
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('The server returned an empty or invalid response.')
  }
  return payload as T
}

function BillFilePreview({ file, previewUrl }: { file: File; previewUrl: string }) {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2.5">
        {isPdf ? <FileText size={16} className="text-electric" /> : <Image size={16} className="text-electric" />}
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">{file.name}</p>
        <span className="shrink-0 text-[10px] text-slate-400">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
      </div>
      {isPdf ? (
        <iframe title={`Preview of ${file.name}`} src={previewUrl} className="h-64 w-full bg-white sm:h-80" />
      ) : (
        <div className="grid h-64 place-items-center p-3 sm:h-80">
          <img src={previewUrl} alt={`Preview of ${file.name}`} className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  )
}

function BillUploadArea({
  onFile,
  disabled,
}: {
  onFile: (file: File) => void
  disabled: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function acceptFiles(files: FileList | null) {
    if (files?.[0]) onFile(files[0])
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (!disabled) acceptFiles(event.dataTransfer.files)
      }}
      className={`rounded-2xl border-2 border-dashed p-6 text-center transition sm:p-8 ${
        dragging ? 'border-electric bg-blue-50' : 'border-slate-200 bg-slate-50/70'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="sr-only"
        aria-label="Choose a bill file"
        disabled={disabled}
        onChange={(event) => acceptFiles(event.currentTarget.files)}
      />
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-blue-50 text-electric">
        <Upload size={20} />
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-800">Drop your bill here</p>
      <p className="mt-1 text-xs text-slate-500">PDF, JPG, or PNG · up to 10 MB</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mt-4 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed"
      >
        Browse files
      </button>
    </div>
  )
}

function BillReviewForm({
  details,
  onChange,
  onConfirm,
  onCancel,
  saving,
}: {
  details: BillDetails
  onChange: (details: BillDetails) => void
  onConfirm: () => void
  onCancel: () => void
  saving: boolean
}) {
  function update<K extends keyof BillDetails>(field: K, value: BillDetails[K]) {
    onChange({ ...details, [field]: value })
  }

  const inputClassName = 'mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100'

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onConfirm()
      }}
      className="space-y-4"
    >
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3.5">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-electric" />
        <div>
          <p className="text-xs font-semibold text-blue-900">BharatCode bill analysis complete</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-blue-800/75">
            Review the details read from your document. Fields not found are left blank.
          </p>
        </div>
      </div>
      {(details.missingFields.length > 0 || details.uncertainFields.length > 0) && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900">
          <p className="font-semibold">Please verify uncertain or unreadable fields</p>
          {details.missingFields.length > 0 && <p className="mt-1">Not found: {details.missingFields.join(', ')}</p>}
          {details.uncertainFields.length > 0 && <p className="mt-1">Uncertain OCR: {details.uncertainFields.join(', ')}</p>}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-600">
          Provider name *
          <input required value={details.provider} onChange={(event) => update('provider', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Customer name
          <input value={details.customerName} onChange={(event) => update('customerName', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Bill amount *
          <input required type="number" min="0.01" step="0.01" value={details.amount} onChange={(event) => update('amount', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Tax amount
          <input type="number" min="0" step="0.01" value={details.taxAmount} onChange={(event) => update('taxAmount', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Currency *
          <select required value={details.currency} onChange={(event) => update('currency', event.target.value)} className={inputClassName}>
            <option value="">Choose currency</option><option value="INR">INR · ₹</option><option value="USD">USD · $</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Billing date
          <input type="date" value={details.billingDate} onChange={(event) => update('billingDate', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Due date *
          <input required type="date" value={details.dueDate} onChange={(event) => update('dueDate', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Document type
          <select value={details.documentType} onChange={(event) => update('documentType', event.target.value as BillDetails['documentType'])} className={inputClassName}>
            <option value="">Not identified</option><option value="utility_bill">Utility bill</option><option value="invoice">Invoice</option><option value="receipt">Receipt</option><option value="other">Other</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Invoice number
          <input value={details.invoiceNumber} onChange={(event) => update('invoiceNumber', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Account / reference number
          <input value={details.accountReference} onChange={(event) => update('accountReference', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Units consumed
          <input value={details.unitsConsumed} onChange={(event) => update('unitsConsumed', event.target.value)} className={inputClassName} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Billing period
          <input value={details.billingPeriod} onChange={(event) => update('billingPeriod', event.target.value)} className={inputClassName} />
        </label>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50">
          <RotateCcw size={14} /> Start over
        </button>
        <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-electric px-4 py-2.5 text-xs font-medium text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">
          {saving ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />} {saving ? 'Saving bill…' : 'Save reviewed bill'}
        </button>
      </div>
    </form>
  )
}

function SavedBills({
  bills,
  paymentRequests,
  verifiedRecipients,
  explanations,
  busyId,
  onVerify,
  onExplain,
  onPrepare,
  onApprove,
  onSupport,
}: {
  bills: SavedBill[]
  paymentRequests: PaymentRequest[]
  verifiedRecipients: string[]
  explanations: Record<string, string>
  busyId: string | null
  onVerify: (provider: string) => void
  onExplain: (billId: string) => void
  onPrepare: (bill: SavedBill) => void
  onApprove: (payment: PaymentRequest, simulateFailure?: boolean) => void
  onSupport: (payment: PaymentRequest) => void
}) {
  const verified = new Set(verifiedRecipients.map((name) => name.trim().toLowerCase()))
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Saved bills and payment preparation</h2>
          <p className="mt-1 text-xs text-slate-500">Bills are persisted for risk comparison. Payment requests run in sandbox only and require explicit approval.</p>
        </div>
        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-medium text-amber-700">{bills.length} {bills.length === 1 ? 'bill' : 'bills'}</span>
      </div>
      {bills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center">
          <FileText size={20} className="mx-auto text-slate-300" />
          <p className="mt-2 text-xs font-medium text-slate-600">No saved bills</p>
          <p className="mt-1 text-[11px] text-slate-400">Extract, review, and save a bill to compare it with history.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {bills.map((bill) => (
            <article key={bill.id} className="space-y-3 py-4 first:pt-1 last:pb-0">
              <div className="flex flex-wrap items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-electric"><FileText size={17} /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{bill.provider_name || 'Unknown provider'}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {bill.currency && bill.bill_amount !== null ? `${bill.currency} ${bill.bill_amount.toFixed(2)}` : 'Amount/currency missing'}
                    {bill.due_date ? ` · Due ${bill.due_date}` : ' · Due date missing'}
                    {bill.invoice_number ? ` · Invoice ${bill.invoice_number}` : ''}
                    {bill.account_reference ? ` · Ref ${bill.account_reference}` : ''}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${bill.risk.level === 'High' ? 'bg-rose-50 text-rose-700' : bill.risk.level === 'Medium' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                  {bill.risk.level} risk · {bill.risk.score}/100
                </span>
              </div>
              {bill.risk.evidence.length > 0 && (
                <ul className="ml-13 space-y-1 text-[11px] text-slate-600">
                  {bill.risk.evidence.map((item, index) => (
                    <li key={`${item.type}-${index}`}>
                      {item.type.replace(/_/g, ' ')}
                      {item.type === 'amount_increase' && `: ${Number((item as { previous_amount?: number }).previous_amount).toFixed(2)} → ${bill.currency ?? ''} ${bill.bill_amount?.toFixed(2)} (${Number((item as { percentage_change?: number }).percentage_change).toFixed(1)}% increase)`}
                      {item.type === 'missing_information' && `: ${(item.fields ?? []).join(', ')}`}
                      {item.type.includes('duplicate') && `: ${bill.risk.duplicates.map((duplicate) => duplicate.reason).join(' ')}`}
                      {item.type === 'new_or_unverified_recipient' && ': verify provider details before proceeding.'}
                      {item.type === 'unusual_frequency' && `: ${String((item as { details?: unknown }).details ?? '')}`}
                      {item.type === 'recipient_mismatch' && `: ${String((item as { details?: unknown }).details ?? '')}`}
                      {item.type === 'payment_already_exists' && ': a matching payment request exists.'}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-slate-500">{bill.risk.recommended_action} Risk indicators are not a fraud determination.</p>
              {explanations[bill.id] && <p className="rounded-lg bg-blue-50 p-3 text-xs leading-relaxed text-blue-900">{explanations[bill.id]}</p>}
              <div className="flex flex-wrap gap-2">
                {bill.provider_name && (
                  <button disabled={busyId === bill.id || verified.has(bill.provider_name.trim().toLowerCase())} onClick={() => onVerify(bill.provider_name!)} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-600 disabled:opacity-50">
                    {verified.has(bill.provider_name.trim().toLowerCase()) ? 'Provider user-verified' : 'I verified this provider'}
                  </button>
                )}
                <button disabled={busyId === bill.id} onClick={() => onExplain(bill.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-600 disabled:opacity-50">
                  Explain with BharatCode
                </button>
                {!paymentRequests.some((request) => request.bill_id === bill.id) && (
                  <button disabled={busyId === bill.id} onClick={() => onPrepare(bill)} className="rounded-lg bg-electric px-3 py-2 text-[11px] font-medium text-white disabled:opacity-50">
                    Prepare sandbox payment
                  </button>
                )}
              </div>
              {paymentRequests.filter((request) => request.bill_id === bill.id).map((payment) => (
                <div key={payment.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-800">Sandbox payment · {payment.status.replace(/_/g, ' ')}</p>
                    <p className="text-xs font-semibold text-slate-800">{payment.currency} {payment.amount.toFixed(2)}</p>
                  </div>
                  {payment.error_message && <p className="mt-1 text-xs text-rose-700">{payment.error_code}: {payment.error_message}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {payment.status === 'prepared' && (
                      <>
                        <button disabled={busyId === payment.id} onClick={() => onApprove(payment)} className="rounded-lg bg-electric px-3 py-2 text-[11px] font-medium text-white disabled:opacity-50">Explicitly approve sandbox</button>
                        <button disabled={busyId === payment.id} onClick={() => onApprove(payment, true)} className="rounded-lg border border-rose-200 px-3 py-2 text-[11px] font-medium text-rose-700 disabled:opacity-50">Simulate sandbox failure</button>
                      </>
                    )}
                    {(payment.status === 'failed' || payment.status === 'pending') && (
                      <button disabled={busyId === payment.id} onClick={() => onSupport(payment)} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-700 disabled:opacity-50">Create support request</button>
                    )}
                    {payment.status === 'succeeded' && <p className="text-[11px] text-emerald-700">Sandbox success only; verify with the actual provider before considering any real bill paid.</p>}
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

export default function BillRecognition() {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [extractionError, setExtractionError] = useState('')
  const [isExtracting, setIsExtracting] = useState(false)
  const [details, setDetails] = useState<BillDetails | null>(null)
  const [savedBills, setSavedBills] = useState<SavedBill[]>([])
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([])
  const [verifiedRecipients, setVerifiedRecipients] = useState<string[]>([])
  const [explanations, setExplanations] = useState<Record<string, string>>({})
  const [loadingBills, setLoadingBills] = useState(true)
  const [billError, setBillError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [savingBill, setSavingBill] = useState(false)
  const [confirmedMessage, setConfirmedMessage] = useState('')

  const loadSavedData = useCallback(async () => {
    setLoadingBills(true)
    setBillError('')
    try {
      const [bills, payments, recipients] = await Promise.all([
        apiRequest<SavedBill[]>('/api/bills'),
        apiRequest<PaymentRequest[]>('/api/payment-requests'),
        apiRequest<{ provider_name: string; confirmed_at: string }[]>('/api/recipients'),
      ])
      setSavedBills(bills)
      setPaymentRequests(payments)
      setVerifiedRecipients(recipients.map((recipient) => recipient.provider_name))
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'Could not load saved bills.')
    } finally {
      setLoadingBills(false)
    }
  }, [])

  useEffect(() => {
    void loadSavedData()
  }, [loadSavedData])

  useEffect(() => {
    if (!file) {
      setPreviewUrl('')
      return
    }

    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function selectFile(nextFile: File) {
    const error = validateBillFile(nextFile)
    setUploadError(error ?? '')
    setExtractionError('')
    setConfirmedMessage('')
    if (error) {
      setFile(null)
      setDetails(null)
      return
    }

    setFile(nextFile)
    setDetails(null)
  }

  async function extractDetails() {
    if (!file) return
    setIsExtracting(true)
    setExtractionError('')
    setConfirmedMessage('')
    try {
      setDetails(await extractBillDetails(file))
    } catch (error) {
      setExtractionError(error instanceof Error ? error.message : 'Bill extraction failed. Please try again.')
    } finally {
      setIsExtracting(false)
    }
  }

  function startOver() {
    setFile(null)
    setDetails(null)
    setUploadError('')
    setExtractionError('')
    setConfirmedMessage('')
  }

  async function confirmDetails() {
    if (!file || !details || savingBill) return
    setSavingBill(true)
    setBillError('')
    setConfirmedMessage('')
    try {
      const result = await apiRequest<{ bill: SavedBill; risk: BillRisk }>('/api/bills', {
        method: 'POST',
        body: JSON.stringify({
          provider_name: details.provider,
          customer_name: details.customerName || null,
          bill_amount: Number(details.amount),
          tax_amount: details.taxAmount ? Number(details.taxAmount) : null,
          currency: details.currency,
          billing_date: details.billingDate || null,
          due_date: details.dueDate,
          invoice_number: details.invoiceNumber || null,
          account_reference: details.accountReference || null,
          units_consumed: details.unitsConsumed || null,
          billing_period: details.billingPeriod || null,
          document_type: details.documentType || null,
        }),
      })
      setConfirmedMessage(`${result.bill.provider_name} bill saved. Risk checks use bill history; any transfer remains a separate sandbox-only approval.`)
      setFile(null)
      setDetails(null)
      setUploadError('')
      setExtractionError('')
      await loadSavedData()
      void explainRisk(result.bill.id)
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'Could not save this bill.')
    } finally {
      setSavingBill(false)
    }
  }

  async function explainRisk(billId: string) {
    setBusyId(billId)
    setBillError('')
    try {
      const result = await apiRequest<{ explanation: string; recommended_action: string }>(
        `/api/bills/${encodeURIComponent(billId)}/risk/explanation`,
        { method: 'POST' },
      )
      setExplanations((current) => ({
        ...current,
        [billId]: `${result.explanation} Recommended action: ${result.recommended_action}`,
      }))
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'BharatCode could not explain this risk assessment.')
    } finally {
      setBusyId(null)
    }
  }

  async function verifyRecipient(provider: string) {
    if (!window.confirm(`Confirm that you have independently checked the provider identity for "${provider}"? This records your confirmation only; it is not third-party verification.`)) return
    setBusyId(provider)
    setBillError('')
    try {
      await apiRequest('/api/recipients/verify', {
        method: 'POST',
        body: JSON.stringify({ provider_name: provider }),
      })
      await loadSavedData()
      setConfirmedMessage(`${provider} marked as user-confirmed. This is not a provider identity check.`)
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'Could not record provider verification.')
    } finally {
      setBusyId(null)
    }
  }

  async function preparePayment(bill: SavedBill) {
    if (bill.risk.duplicates.some((duplicate) => duplicate.type === 'possible')) {
      if (!window.confirm('A possible duplicate was detected. Have you checked the existing bill before preparing a sandbox payment?')) return
    }
    setBusyId(bill.id)
    setBillError('')
    try {
      await apiRequest('/api/payment-requests', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          bill_id: bill.id,
          confirm_possible_duplicate: bill.risk.duplicates.some((duplicate) => duplicate.type === 'possible'),
        }),
      })
      setConfirmedMessage('Sandbox payment request prepared. It has not been submitted; explicit approval is required.')
      await loadSavedData()
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'Could not prepare a sandbox payment.')
    } finally {
      setBusyId(null)
    }
  }

  async function approvePayment(payment: PaymentRequest, simulateFailure = false) {
    const bill = savedBills.find((item) => item.id === payment.bill_id)
    const highRisk = bill?.risk.level === 'High'
    const action = simulateFailure ? 'simulate a sandbox failure' : 'approve this sandbox transaction'
    if (!window.confirm(`Explicitly ${action} for ${payment.currency} ${payment.amount.toFixed(2)} to ${payment.recipient}? No real payment provider will be contacted.${highRisk ? ' This bill has High risk evidence.' : ''}`)) return
    setBusyId(payment.id)
    setBillError('')
    try {
      await apiRequest(`/api/payment-requests/${encodeURIComponent(payment.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          confirm_sandbox_payment: true,
          simulate_failure: simulateFailure,
          acknowledge_high_risk: highRisk,
        }),
      })
      setConfirmedMessage(simulateFailure ? 'Sandbox failure recorded. No payment was sent.' : 'Sandbox success recorded only. No real payment was sent.')
      await loadSavedData()
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'Could not record sandbox approval.')
    } finally {
      setBusyId(null)
    }
  }

  async function createSupportRequest(payment: PaymentRequest) {
    setBusyId(payment.id)
    setBillError('')
    try {
      const result = await apiRequest<{ id: string }>(
        `/api/payment-requests/${encodeURIComponent(payment.id)}/support`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      setConfirmedMessage(`Support request ${result.id} created for this sandbox payment.`)
    } catch (error) {
      setBillError(error instanceof Error ? error.message : 'Could not create a support request.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-[25px] font-semibold tracking-tight text-slate-900">Bills, handled beautifully.</h2>
          <p className="mt-1 text-sm text-slate-500">Upload a bill, review the extracted details, and save verified information to this demo's database.</p>
        </div>
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5 text-[10px] font-medium text-blue-700">
          <Sparkles size={13} /> Local OCR + BharatCode · no payments
        </span>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-slate-900">Add a bill</h2>
            <p className="mt-1 text-xs text-slate-500">Your original document stays visible while you review the extracted details.</p>
          </div>
          <BillUploadArea onFile={selectFile} disabled={isExtracting} />

          {uploadError && (
            <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-rose-600">
              <X size={14} /> {uploadError}
            </p>
          )}

          {file && previewUrl && (
            <div className="mt-4 space-y-3">
              <BillFilePreview file={file} previewUrl={previewUrl} />
              <button
                type="button"
                onClick={extractDetails}
                disabled={isExtracting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-electric px-4 py-3 text-sm font-medium text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-70"
              >
                {isExtracting ? <><LoaderCircle size={17} className="animate-spin" /> Reading locally and analyzing…</> : <><Sparkles size={17} /> Extract details</>}
              </button>
              {extractionError && <p role="alert" className="text-xs text-rose-600">{extractionError}</p>}
            </div>
          )}

        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-slate-900">Review bill details</h2>
            <p className="mt-1 text-xs text-slate-500">Check every detail before adding it to approval.</p>
          </div>
          {details ? (
            <BillReviewForm
              details={details}
              onChange={setDetails}
              onConfirm={confirmDetails}
              onCancel={startOver}
              saving={savingBill}
            />
          ) : (
            <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-8 text-center">
              <div>
                <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white text-slate-400 shadow-sm"><FileText size={18} /></div>
                <p className="mt-3 text-xs font-medium text-slate-600">Details will appear here</p>
                <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-slate-400">Your document is read locally with OCR. Only its extracted text is sent to BharatCode to identify editable bill details.</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {billError && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{billError}</p>}
      {confirmedMessage && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">{confirmedMessage}</p>}
      {loadingBills ? (
        <div className="h-28 animate-pulse rounded-2xl bg-slate-100" aria-label="Loading saved bills" />
      ) : (
        <SavedBills
          bills={savedBills}
          paymentRequests={paymentRequests}
          verifiedRecipients={verifiedRecipients}
          explanations={explanations}
          busyId={busyId}
          onVerify={(provider) => void verifyRecipient(provider)}
          onExplain={(billId) => void explainRisk(billId)}
          onPrepare={(bill) => void preparePayment(bill)}
          onApprove={(payment, failure) => void approvePayment(payment, failure)}
          onSupport={(payment) => void createSupportRequest(payment)}
        />
      )}
    </div>
  )
}
