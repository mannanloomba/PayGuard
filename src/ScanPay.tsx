import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { AlertTriangle, Camera, CheckCircle2, LoaderCircle, QrCode, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import jsQR from 'jsqr'
import { useSearchParams } from 'react-router-dom'
import { formatCurrency } from './payment-format'
import { apiFetch } from './api-client'

type PaymentCategory =
  | 'person_to_person'
  | 'merchant'
  | 'qr_payment'
  | 'account_transfer'
  | 'utility_bill'
  | 'invoice'
  | 'everyday'

type Recipient = {
  id: string
  name: string
  recipient_type: 'person' | 'merchant' | 'bank_account' | 'utility' | 'service' | 'other'
  identifier: string
  account_reference: string | null
  is_verified: boolean
  details_changed: boolean
}

type QrDetails = {
  recipient_identifier: string | null
  upi_id_valid: boolean
  recipient_name: string | null
  merchant_code: string | null
  amount: number | null
  currency: 'INR' | 'USD'
  purpose: string
  order_reference: string | null
  transaction_reference: string | null
  validation_warnings: string[]
  payment_initiated: false
}

type Risk = {
  level: 'Low' | 'Medium' | 'High'
  score: number
  evidence: { type: string; points: number; details?: unknown }[]
  duplicate_blocked: boolean
  recommended_action: string
  explanation: string
  matched_saved_recipients: { id: string; name: string; is_user_confirmed: boolean }[]
}

type Assessment = {
  qr: QrDetails
  risk: Risk
  expected_recipient: { id: string; name: string; identifier: string; is_user_confirmed: boolean } | null
}

type Transaction = {
  id: string
  recipient: string
  category: string
  amount: number
  currency: 'INR' | 'USD'
  status: string
  payment_date: string
}

type UniversalPayment = {
  id: string
  status: string
  approval_status: string
  risk: { level: string; score: number }
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
      else if (Array.isArray(body.detail)) message = body.detail.map((item) => item.msg).filter(Boolean).join(', ')
    } catch {
      // Retain the HTTP status when the server does not return JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function isImageFile(file: File) {
  const extension = file.name.toLocaleLowerCase().split('.').pop()
  return file.type === 'image/png' || file.type === 'image/jpeg'
    || (!file.type && ['png', 'jpg', 'jpeg'].includes(extension ?? ''))
}

function riskTone(level: Risk['level']) {
  return level === 'High'
    ? 'border-rose-200 bg-rose-50 text-rose-800'
    : level === 'Medium'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
}

function localToday() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function decodeQrFromCanvas(source: CanvasImageSource, width: number, height: number) {
  if (width <= 0 || height <= 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Local QR decoding is unavailable in this browser.')
  context.drawImage(source, 0, 0, width, height)
  const image = context.getImageData(0, 0, width, height)
  return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null
}

function ScanPay() {
  const [searchParams] = useSearchParams()
  const initialCategory = searchParams.get('category')
  const categories: { value: PaymentCategory; label: string }[] = [
    { value: 'qr_payment', label: 'QR / UPI payment' },
    { value: 'person_to_person', label: 'Person-to-person' },
    { value: 'merchant', label: 'Merchant / shopping' },
    { value: 'account_transfer', label: 'Account transfer' },
    { value: 'utility_bill', label: 'Utility bill' },
    { value: 'invoice', label: 'Invoice' },
    { value: 'everyday', label: 'Everyday payment' },
  ]
  const validCategory = categories.some((item) => item.value === initialCategory)
  const [category, setCategory] = useState<PaymentCategory>(
    validCategory ? initialCategory as PaymentCategory : 'qr_payment',
  )
  const [amount, setAmount] = useState(searchParams.get('amount') ?? '')
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [recipientId, setRecipientId] = useState('')
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [assessmentInput, setAssessmentInput] = useState<{
    recipientId: string
    amount: string
    category: PaymentCategory
    paymentDate: string
  } | null>(null)
  const [aiExplanation, setAiExplanation] = useState<{ explanation: string; recommended_action: string } | null>(null)
  const [aiError, setAiError] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [rawPayload, setRawPayload] = useState('')
  const [scanSource, setScanSource] = useState<'upload' | 'camera' | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [purpose, setPurpose] = useState('QR payment')
  const [orderReference, setOrderReference] = useState('')
  const [paymentDate, setPaymentDate] = useState(localToday)
  const [recipientName, setRecipientName] = useState('')
  const [savingRecipient, setSavingRecipient] = useState(false)
  const [savedPayment, setSavedPayment] = useState<UniversalPayment | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [cameraActive, setCameraActive] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationRef = useRef<number | null>(null)
  const cameraRunRef = useRef(false)

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true)
    setHistoryError('')
    try {
      const records = await apiRequest<Transaction[]>('/api/transactions?category=qr_payment')
      setTransactions(records.slice(0, 5))
    } catch (loadError) {
      setHistoryError(loadError instanceof Error ? loadError.message : 'Could not load QR payment history.')
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    apiRequest<Recipient[]>('/api/payment-recipients')
      .then(setRecipients)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not load saved recipients.'))
    void loadHistory()
  }, [loadHistory])

  const stopCamera = useCallback(() => {
    cameraRunRef.current = false
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraActive(false)
  }, [])

  useEffect(() => () => {
    cameraRunRef.current = false
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  function clearScanResult() {
    setAssessment(null)
    setAssessmentInput(null)
    setAiExplanation(null)
    setAiError('')
    setRawPayload('')
    setScanSource(null)
    setReviewOpen(false)
    setReviewConfirmed(false)
    setSavedPayment(null)
  }

  async function assessPayload(payload: string, nextRecipientId = recipientId, nextAmount = amount) {
    setQrLoading(true)
    setError('')
    setNotice('')
    setAiError('')
    setAiExplanation(null)
    setAssessment(null)
    setReviewOpen(false)
    setReviewConfirmed(false)
    setRawPayload(payload)
    try {
      const body = {
        payload,
        expected_recipient_id: nextRecipientId || null,
        expected_amount: nextAmount ? Number(nextAmount) : null,
        category,
        payment_date: paymentDate,
        purpose,
        order_reference: orderReference || null,
      }
      const result = await apiRequest<Assessment>('/api/qr/assess', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setAssessment(result)
      const checkedAmount = nextAmount || (
        result.qr.amount === null ? '' : String(result.qr.amount)
      )
      setAssessmentInput({
        recipientId: nextRecipientId,
        amount: checkedAmount,
        category,
        paymentDate,
      })
      setRecipientId(nextRecipientId)
      setAmount((current) => current || checkedAmount)
      setPurpose(result.qr.purpose)
      setOrderReference(result.qr.transaction_reference ?? '')
      setRecipientName(result.qr.recipient_name ?? '')
      setAiLoading(true)
      try {
        const explanation = await apiRequest<{ explanation: string; recommended_action: string }>('/api/qr/explain', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        setAiExplanation(explanation)
      } catch (explanationError) {
        setAiError(explanationError instanceof Error ? explanationError.message : 'BharatCode QR explanation is unavailable.')
      } finally {
        setAiLoading(false)
      }
    } catch (assessmentError) {
      setError(assessmentError instanceof Error ? assessmentError.message : 'Could not analyze this QR code.')
    } finally {
      setQrLoading(false)
    }
  }

  async function decodeImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    stopCamera()
    clearScanResult()
    setError('')
    setNotice('')
    if (!isImageFile(file)) {
      setError('Choose a PNG, JPG, or JPEG QR image.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('QR images must be 10 MB or smaller.')
      return
    }
    const Detector = (window as Window & {
      BarcodeDetector?: new (options?: { formats: string[] }) => {
        detect(source: ImageBitmapSource | HTMLVideoElement): Promise<{ rawValue: string }[]>
      }
    }).BarcodeDetector
    setScanSource('upload')
    try {
      const bitmap = await createImageBitmap(file)
      let payload: string | undefined
      try {
        if (Detector) {
          const [barcode] = await new Detector({ formats: ['qr_code'] }).detect(bitmap)
          payload = barcode?.rawValue
        } else {
          payload = decodeQrFromCanvas(bitmap, bitmap.width, bitmap.height) ?? undefined
        }
      } finally {
        bitmap.close()
      }
      if (!payload) throw new Error('No QR code was found in that image.')
      const matchingRecipient = recipients.find(
        (recipient) => recipient.identifier.toLocaleLowerCase() === extractUpiId(payload)?.toLocaleLowerCase(),
      )
      const amountFromUrl = searchParams.get('amount') ?? ''
      await assessPayload(payload, matchingRecipient?.id ?? recipientId, amountFromUrl || amount)
    } catch (decodeError) {
      setError(decodeError instanceof Error ? decodeError.message : 'Could not decode this QR image locally.')
    }
  }

  async function startCamera() {
    const Detector = (window as Window & {
      BarcodeDetector?: new (options?: { formats: string[] }) => {
        detect(source: ImageBitmapSource | HTMLVideoElement): Promise<{ rawValue: string }[]>
      }
    }).BarcodeDetector
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access is unavailable. Use HTTPS or localhost and upload a QR image instead.')
      return
    }
    clearScanResult()
    setError('')
    setNotice('')
    setScanSource('camera')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      streamRef.current = stream
      cameraRunRef.current = true
      setCameraActive(true)
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null
      const findFrame = async () => {
        const video = videoRef.current
        if (!cameraRunRef.current || !video) return
        try {
          const [barcode] = detector ? await detector.detect(video) : []
          const payload = barcode?.rawValue
            ?? decodeQrFromCanvas(video, video.videoWidth, video.videoHeight)
          if (payload) {
            stopCamera()
            const matchingRecipient = recipients.find(
              (recipient) => recipient.identifier.toLocaleLowerCase() === extractUpiId(payload)?.toLocaleLowerCase(),
            )
            const amountFromUrl = searchParams.get('amount') ?? ''
            await assessPayload(payload, matchingRecipient?.id ?? recipientId, amountFromUrl || amount)
            return
          }
        } catch (scanError) {
          stopCamera()
          setError(scanError instanceof Error ? scanError.message : 'Could not scan this camera frame.')
          return
        }
        animationRef.current = requestAnimationFrame(() => { void findFrame() })
      }
      animationRef.current = requestAnimationFrame(() => { void findFrame() })
    } catch (cameraError) {
      stopCamera()
      const reason = typeof cameraError === 'object' && cameraError !== null && 'name' in cameraError
        ? String(cameraError.name)
        : ''
      setError(reason === 'NotAllowedError' || reason === 'PermissionDeniedError'
        ? 'Camera permission was denied. Allow camera access in your browser settings or upload a QR image.'
        : cameraError instanceof Error ? `Camera could not start: ${cameraError.message}` : 'Camera could not start.')
    }
  }

  async function reassess() {
    if (rawPayload) await assessPayload(rawPayload, recipientId, amount)
  }

  async function saveUnverifiedRecipient() {
    if (!assessment?.qr.recipient_identifier || !assessment.qr.upi_id_valid) return
    setSavingRecipient(true)
    setError('')
    try {
      const saved = await apiRequest<Recipient>('/api/payment-recipients', {
        method: 'POST',
        body: JSON.stringify({
          name: recipientName.trim() || assessment.qr.recipient_name || 'QR payee',
          recipient_type: 'merchant',
          identifier: assessment.qr.recipient_identifier,
          account_reference: null,
        }),
      })
      setRecipients((current) => [saved, ...current])
      setRecipientId(saved.id)
      setNotice('Recipient saved but remains unconfirmed. This does not verify the account or UPI ID.')
      await assessPayload(rawPayload, saved.id, amount)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this recipient.')
    } finally {
      setSavingRecipient(false)
    }
  }

  async function savePreparedRequest() {
    if (!assessment || !recipientId || !assessment.qr.upi_id_valid || !reviewConfirmed || assessment.risk.duplicate_blocked) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const saved = await apiRequest<UniversalPayment>('/api/universal-payment-requests', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          recipient_id: recipientId,
          category,
          payment_method: 'upi_qr',
          amount: Number(amount),
          currency: assessment.qr.currency,
          purpose: purpose.trim() || 'QR payment',
          payment_date: paymentDate,
          order_reference: category === 'merchant'
            ? orderReference.trim() || assessment.qr.transaction_reference
            : assessment.qr.transaction_reference,
          recurrence: null,
          qr_recipient_identifier: assessment.qr.recipient_identifier,
          qr_amount: assessment.qr.amount,
          qr_payee_name: assessment.qr.recipient_name,
          qr_merchant_code: assessment.qr.merchant_code,
          qr_transaction_reference: assessment.qr.transaction_reference,
        }),
      })
      setSavedPayment(saved)
      setReviewOpen(false)
      setNotice('Sandbox request prepared and saved. No money was sent; separate approval is still required.')
      await loadHistory()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not prepare this sandbox request.')
    } finally {
      setSaving(false)
    }
  }

  const selectedRecipient = recipients.find((item) => item.id === recipientId) ?? null
  const assessmentIsCurrent = !!assessmentInput
    && assessmentInput.recipientId === recipientId
    && assessmentInput.amount === amount
    && assessmentInput.category === category
    && assessmentInput.paymentDate === paymentDate
  const amountIsValid = Number.isFinite(Number(amount)) && Number(amount) > 0
  const merchantReferenceValid = category !== 'merchant' || !!orderReference.trim()

  return (
    <div className="page-enter space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-slate-500">Decode payment QR data on your device before reviewing the request.</p>
          <h2 className="mt-1 text-[25px] font-semibold tracking-tight text-slate-900">Scan &amp; Pay protection</h2>
        </div>
        <span className="inline-flex items-center gap-2 self-start rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-900">
          <ShieldCheck size={15} /> Sandbox only
        </span>
      </header>

      <div role="note" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
        <AlertTriangle size={17} className="mt-0.5 shrink-0" />
        <p>QR content is untrusted. PayGuard cannot verify a bank account, merchant, or UPI ID. Risk signals are not proof of fraud, and preparing a request never initiates a payment.</p>
      </div>

      {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      {notice && <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={15} /></button></div>}

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(300px,.95fr)]">
        <div className="space-y-5 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-electric"><QrCode size={20} /></div>
            <div><h3 className="text-base font-semibold text-slate-900">Scan a UPI QR</h3><p className="mt-0.5 text-xs text-slate-500">Image decoding happens locally in your browser.</p></div>
          </div>

          <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center hover:bg-slate-100">
            <QrCode size={23} className="mb-2 text-slate-500" />
            <span className="text-sm font-medium text-slate-800">Choose a QR image</span>
            <span className="mt-1 text-xs text-slate-500">PNG, JPG or JPEG · up to 10 MB</span>
            <input aria-label="Upload QR image" className="sr-only" type="file" accept="image/png,image/jpeg,.jpg,.jpeg" onChange={(event) => void decodeImage(event)} />
          </label>

          <div className="flex items-center gap-3 text-[11px] text-slate-400"><span className="h-px flex-1 bg-slate-200" />OR<span className="h-px flex-1 bg-slate-200" /></div>
          <div className="space-y-3">
            {!cameraActive
              ? <button type="button" onClick={() => void startCamera()} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"><Camera size={16} /> Start camera scan</button>
              : <button type="button" onClick={stopCamera} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-4 text-sm font-medium text-rose-700 hover:bg-rose-50"><X size={15} /> Stop camera</button>}
            <video ref={videoRef} autoPlay muted playsInline aria-label="Live QR camera preview" className={cameraActive ? 'aspect-video w-full rounded-xl bg-slate-950 object-cover' : 'hidden'} />
            {cameraActive && <p role="status" className="text-xs text-slate-500">Camera is active. Point it at a UPI QR; permission can be revoked in browser settings.</p>}
          </div>
          {scanSource && assessment && <p className="text-[11px] text-slate-500">Scanned from {scanSource === 'camera' ? 'camera' : 'image'}; URI fields were validated by the backend.</p>}
        </div>

        <div className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <h3 className="text-base font-semibold text-slate-900">Payment details</h3>
          {qrLoading ? (
            <div role="status" className="flex items-center gap-2 py-10 text-sm text-slate-500"><LoaderCircle size={16} className="animate-spin" /> Checking decoded QR details…</div>
          ) : !assessment ? (
            <div className="flex min-h-40 flex-col items-center justify-center text-center text-slate-500">
              <ShieldAlert size={25} className="mb-2 text-slate-400" />
              <p className="text-sm font-medium text-slate-700">No QR scanned</p>
              <p className="mt-1 max-w-xs text-xs">Upload an image or start the camera. We’ll compare the decoded details with saved recipient data.</p>
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div className="col-span-2 rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">UPI ID · not externally verified</dt><dd className="mt-1 break-all font-semibold text-slate-900">{assessment.qr.recipient_identifier || 'Missing'}</dd></div>
                <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Payee name</dt><dd className="mt-1 font-semibold text-slate-900">{assessment.qr.recipient_name || 'Not provided'}</dd></div>
                <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Merchant code</dt><dd className="mt-1 font-semibold text-slate-900">{assessment.qr.merchant_code || 'Not provided'}</dd></div>
                <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">QR amount</dt><dd className="mt-1 font-semibold text-slate-900">{assessment.qr.amount === null ? 'Not specified' : formatCurrency(assessment.qr.amount, assessment.qr.currency)}</dd></div>
                <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Transaction reference</dt><dd className="mt-1 break-all font-semibold text-slate-900">{assessment.qr.transaction_reference || 'Not provided'}</dd></div>
                <div className="col-span-2 rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Purpose</dt><dd className="mt-1 font-semibold text-slate-900">{assessment.qr.purpose}</dd></div>
              </dl>
              {!assessment.qr.upi_id_valid && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">This QR has a missing or invalid UPI ID and cannot be prepared as a payment request.</p>}
              <label className="block text-xs font-medium text-slate-600">Compare with saved recipient (optional)
                <select value={recipientId} onChange={(event) => { setRecipientId(event.target.value); setAiExplanation(null); setReviewOpen(false) }} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">
                  <option value="">No selected recipient</option>
                  {recipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.name} · {recipient.identifier}{recipient.is_verified ? ' · user-confirmed' : ' · unconfirmed'}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-slate-600">Payment amount · editable
                <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => { setAmount(event.target.value); setAiExplanation(null); setReviewOpen(false) }} placeholder="Enter amount when not in QR" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
              </label>
              {!assessmentIsCurrent && <div><p role="status" className="mb-2 text-xs text-amber-800">Payment details changed. Recheck the risk report before review.</p><button type="button" disabled={qrLoading} onClick={() => void reassess()} className="h-10 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Recheck payment details</button></div>}
              {assessmentIsCurrent && assessment.risk.matched_saved_recipients.length === 0 && assessment.qr.upi_id_valid && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs text-amber-900">No exact UPI ID match in saved recipients. This does not prove the QR is unsafe or legitimate.</p>
                  <label className="mt-3 block text-xs font-medium text-amber-950">Name for your local recipient record
                    <input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} maxLength={160} className="mt-1.5 h-10 w-full rounded-xl border border-amber-300 bg-white px-3 text-sm font-normal text-slate-800" />
                  </label>
                  <button type="button" disabled={savingRecipient} onClick={() => void saveUnverifiedRecipient()} className="mt-2 rounded-lg border border-amber-300 px-3 py-2 text-xs font-medium text-amber-900 disabled:opacity-50">{savingRecipient ? 'Saving…' : 'Save as unconfirmed recipient'}</button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {assessment && (
        <section className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs font-medium uppercase tracking-wide text-electric">AI-assisted assessment · heuristic score</p><h3 className="mt-1 text-lg font-semibold text-slate-900">QR payment risk report</h3></div>
            <span className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${riskTone(assessment.risk.level)}`}>Risk {assessment.risk.level} · {assessment.risk.score}/100</span>
          </div>
          <p className="text-xs leading-relaxed text-slate-600">{assessment.risk.explanation}</p>
          {assessment.risk.evidence.length
            ? <ul className="space-y-2">{assessment.risk.evidence.map((item, index) => <li key={`${item.type}-${index}`} className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700"><span className="font-semibold">{item.type.replace(/_/g, ' ')} · {item.points} points.</span> {typeof item.details === 'string' ? item.details : item.details ? JSON.stringify(item.details) : ''}</li>)}</ul>
            : <p className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-900">No risk signals were found in available data. This does not guarantee safety.</p>}
          <p className="text-xs font-medium text-slate-700">Recommended: {assessment.risk.recommended_action}</p>
          {assessment.risk.duplicate_blocked && <p role="alert" className="rounded-xl bg-rose-100 p-3 text-xs text-rose-800">A request with this transaction reference already exists. This QR request cannot be prepared again.</p>}
          <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-blue-950"><ShieldCheck size={15} /> BharatCode Qwen explanation</p>
            {aiLoading ? <p role="status" className="mt-2 flex items-center gap-2 text-xs text-blue-900"><LoaderCircle size={13} className="animate-spin" /> Explaining the supplied QR evidence…</p>
              : aiExplanation ? <><p className="mt-2 text-xs leading-relaxed text-blue-950">{aiExplanation.explanation}</p><p className="mt-2 text-xs text-blue-900"><strong>Suggested action:</strong> {aiExplanation.recommended_action}</p></>
                : <p role={aiError ? 'alert' : 'status'} className="mt-2 text-xs text-blue-900">{aiError ? `BharatCode explanation unavailable: ${aiError}` : 'No AI explanation is available yet.'}</p>}
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">A risk score is an AI-assisted review signal, not a guarantee against fraud. Recipient-name matches are not identity verification.</p>

          {assessmentIsCurrent && assessment.qr.upi_id_valid && amountIsValid && !assessment.risk.duplicate_blocked && (
            <div className="space-y-4 border-t border-slate-100 pt-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs font-medium text-slate-600">Payment category
                  <select value={category} onChange={(event) => { setCategory(event.target.value as PaymentCategory); setAiExplanation(null); setReviewOpen(false) }} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800">{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                </label>
                <label className="text-xs font-medium text-slate-600">Purpose
                  <input value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={300} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                </label>
                <label className="text-xs font-medium text-slate-600">Payment date
                  <input type="date" value={paymentDate} onChange={(event) => { setPaymentDate(event.target.value); setAiExplanation(null); setReviewOpen(false) }} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                </label>
                {category === 'merchant' && <label className="text-xs font-medium text-slate-600">Order / purchase reference
                  <input required maxLength={160} value={orderReference} onChange={(event) => setOrderReference(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal text-slate-800" />
                </label>}
                {!recipientId && <p className="self-end text-xs text-amber-800 sm:col-span-2 lg:col-span-1">Select or save a recipient before preparing this request.</p>}
              </div>
              {recipientId && !reviewOpen && <button type="button" disabled={!assessmentIsCurrent || !merchantReferenceValid} onClick={() => { setReviewOpen(true); setReviewConfirmed(false) }} className="h-10 rounded-xl bg-electric px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Review sandbox request</button>}
            </div>
          )}

          {reviewOpen && selectedRecipient && (
            <div className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4">
              <div><h4 className="text-sm font-semibold text-slate-900">Review before saving</h4><p className="mt-1 text-xs leading-relaxed text-slate-700">{selectedRecipient.name} · {selectedRecipient.identifier} · {formatCurrency(Number(amount), assessment.qr.currency)} · {category.replace(/_/g, ' ')} · {purpose || 'QR payment'} · {paymentDate}{category === 'merchant' ? ` · ${orderReference}` : ''}</p><p className="mt-1 text-xs text-slate-600">Approval state: awaiting approval. No provider is contacted and no money is transferred.</p></div>
              <label className="flex items-start gap-2 text-xs text-slate-800"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} className="mt-0.5" />I reviewed the decoded UPI ID, amount, warning signals and sandbox-only status. Prepare this request without sending a payment.</label>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!reviewConfirmed || saving || !amountIsValid || !merchantReferenceValid} onClick={() => void savePreparedRequest()} className="h-10 rounded-xl bg-electric px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? 'Saving…' : 'Confirm and save sandbox request'}</button>
                <button type="button" disabled={saving} onClick={() => { setReviewOpen(false); setReviewConfirmed(false) }} className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel review</button>
              </div>
            </div>
          )}
        </section>
      )}

      {savedPayment && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <div className="flex items-center gap-2"><CheckCircle2 size={18} /><div><p className="text-sm font-semibold">Request saved · {savedPayment.status.replace(/_/g, ' ')}</p><p className="mt-0.5 text-xs">Approval: {savedPayment.approval_status.replace(/_/g, ' ')}. This is not a completed payment.</p></div></div>
          <a href="/transactions" className="text-xs font-semibold underline underline-offset-2">View transaction history</a>
        </div>
      )}

      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-base font-semibold text-slate-900">Recent QR payment requests</h3><p className="mt-1 text-xs text-slate-500">Saved sandbox records only.</p></div><button type="button" onClick={() => void loadHistory()} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">Refresh</button></div>
        {loadingHistory ? <div role="status" className="h-16 animate-pulse rounded-xl bg-slate-100" />
          : historyError ? <p role="alert" className="text-xs text-rose-700">{historyError}</p>
            : transactions.length === 0 ? <p className="py-6 text-center text-xs text-slate-500">No QR payment requests have been saved.</p>
              : <ul className="divide-y divide-slate-100">{transactions.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><div><p className="text-sm font-medium text-slate-800">{item.recipient}</p><p className="mt-1 text-xs text-slate-500">{item.payment_date} · {item.status === 'succeeded' ? 'Sandbox success only' : item.status.replace(/_/g, ' ')}</p></div><p className="text-sm font-semibold text-slate-900">{formatCurrency(item.amount, item.currency)}</p></li>)}</ul>}
      </section>
    </div>
  )
}

function extractUpiId(payload: string) {
  try {
    return new URL(payload).searchParams.get('pa')
  } catch {
    return null
  }
}

export default ScanPay
