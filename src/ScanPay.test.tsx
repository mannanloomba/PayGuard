import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import jsQR from 'jsqr'
import ScanPay from './ScanPay'

vi.mock('jsqr', () => ({ default: vi.fn() }))

const qrPayload = 'upi://pay?pa=local%40upi&pn=Local%20Shop&am=125&cu=INR&mc=5411&tr=QR-LOCAL-1'
const recipient = {
  id: 'recipient-1',
  name: 'Local Shop',
  recipient_type: 'merchant',
  identifier: 'local@upi',
  account_reference: null,
  is_verified: false,
  details_changed: false,
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }
}

function assessmentResponse(expectedAmount = 125) {
  return {
    qr: {
      recipient_identifier: 'local@upi',
      upi_id_valid: true,
      recipient_name: 'Local Shop',
      merchant_code: '5411',
      amount: 125,
      currency: 'INR',
      purpose: 'QR payment',
      order_reference: 'QR-LOCAL-1',
      transaction_reference: 'QR-LOCAL-1',
      validation_warnings: [],
      payment_initiated: false,
    },
    risk: {
      level: 'Medium',
      score: expectedAmount === 125 ? 15 : 45,
      evidence: [{ type: 'saved_recipient_unconfirmed', points: 15, details: 'User confirmation is pending.' }],
      duplicate_blocked: false,
      recommended_action: 'Review the payee and amount.',
      explanation: 'A risk indicator is not proof of fraud.',
      matched_saved_recipients: [{ id: recipient.id, name: recipient.name, is_user_confirmed: false }],
    },
    expected_recipient: { id: recipient.id, name: recipient.name, identifier: recipient.identifier, is_user_confirmed: false },
  }
}

describe('Scan & Pay', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let savedRecords: unknown[]

  beforeEach(() => {
    savedRecords = []
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/payment-recipients') return jsonResponse([recipient])
      if (url.startsWith('/api/transactions')) return jsonResponse(savedRecords)
      if (url === '/api/qr/assess') return jsonResponse(assessmentResponse())
      if (url === '/api/qr/explain') {
        return jsonResponse({
          explanation: 'The local record matches, but ownership is not verified.',
          recommended_action: 'Check the payee independently.',
        })
      }
      if (url === '/api/universal-payment-requests') {
        const request = JSON.parse(String(init?.body)) as { amount: number }
        savedRecords = [{
          id: 'payment-1',
          recipient: recipient.name,
          category: 'qr_payment',
          amount: request.amount,
          currency: 'INR',
          status: 'prepared',
          payment_date: '2026-11-05',
        }]
        return jsonResponse({
          id: 'payment-1',
          status: 'prepared',
          approval_status: 'awaiting_approval',
          risk: { level: 'Medium', score: 15 },
        }, 201)
      }
      return jsonResponse({ detail: `Unexpected request ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('BarcodeDetector', class {
      async detect() {
        return [{ rawValue: qrPayload }]
      }
    })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })))
    vi.stubGlobal('crypto', { randomUUID: () => 'idempotency-key-123456' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function uploadQr() {
    const user = userEvent.setup()
    render(<MemoryRouter><ScanPay /></MemoryRouter>)
    const file = new File(['image'], 'payment.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Upload QR image'), file)
    await screen.findByText('QR payment risk report')
    return user
  }

  it('decodes an uploaded QR locally, displays risk, and saves only after review confirmation', async () => {
    const user = await uploadQr()
    expect(await screen.findByText('The local record matches, but ownership is not verified.')).toBeInTheDocument()
    expect(screen.getByText('Risk Medium · 15/100')).toBeInTheDocument()
    expect(screen.getByText('local@upi')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/qr/assess', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining(qrPayload),
    }))

    await user.click(screen.getByRole('button', { name: 'Review sandbox request' }))
    expect(screen.getByText('Review before saving')).toBeInTheDocument()
    const confirmCheckbox = screen.getByRole('checkbox')
    await user.click(confirmCheckbox)
    await user.click(screen.getByRole('button', { name: 'Confirm and save sandbox request' }))

    expect(await screen.findByText('Request saved · prepared')).toBeInTheDocument()
    expect(screen.getByText('Approval: awaiting approval. This is not a completed payment.')).toBeInTheDocument()
    const savedCall = fetchMock.mock.calls.find(([url]) => url === '/api/universal-payment-requests')
    expect(savedCall).toBeDefined()
    const requestBody = JSON.parse(String(savedCall?.[1]?.body)) as Record<string, unknown>
    expect(requestBody).toMatchObject({
      category: 'qr_payment',
      payment_method: 'upi_qr',
      amount: 125,
      qr_recipient_identifier: 'local@upi',
      qr_transaction_reference: 'QR-LOCAL-1',
    })
    expect(await screen.findByText(/2026-11-05.*prepared/)).toBeInTheDocument()
  })

  it('cancels the review without creating a payment request', async () => {
    const user = await uploadQr()
    await user.click(screen.getByRole('button', { name: 'Review sandbox request' }))
    await user.click(screen.getByRole('button', { name: 'Cancel review' }))
    expect(screen.queryByText('Review before saving')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/universal-payment-requests')).toBe(false)
  })

  it('shows an explicit message when camera permission is denied', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')) },
    })
    Object.defineProperty(window, 'BarcodeDetector', {
      configurable: true,
      value: class { async detect() { return [] } },
    })
    const user = userEvent.setup()
    render(<MemoryRouter><ScanPay /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Start camera scan' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera permission was denied')
  })

  it('blocks unsupported image types before attempting local decode', async () => {
    render(<MemoryRouter><ScanPay /></MemoryRouter>)
    const file = new File(['text'], 'not-a-qr.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Upload QR image'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Choose a PNG, JPG, or JPEG'))
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/qr/assess')).toBe(false)
  })

  it('uses the bundled local decoder when BarcodeDetector is unavailable', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 320, height: 240, close: vi.fn() })))
    vi.mocked(jsQR).mockReturnValue({ data: qrPayload } as ReturnType<typeof jsQR>)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(320 * 240 * 4),
        width: 320,
        height: 240,
      })),
    } as unknown as CanvasRenderingContext2D)
    const user = userEvent.setup()
    render(<MemoryRouter><ScanPay /></MemoryRouter>)
    await user.upload(screen.getByLabelText('Upload QR image'), new File(['image'], 'payment.png', { type: 'image/png' }))
    expect(await screen.findByText('QR payment risk report')).toBeInTheDocument()
    expect(jsQR).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 320, 240, { inversionAttempts: 'attemptBoth' })
    expect(fetchMock).toHaveBeenCalledWith('/api/qr/assess', expect.objectContaining({ method: 'POST' }))
  })

  it('clears a previous scan when a newly selected image has no QR code', async () => {
    const user = await uploadQr()
    expect(await screen.findByText('QR payment risk report')).toBeInTheDocument()
    vi.stubGlobal('BarcodeDetector', class {
      async detect() {
        return []
      }
    })
    await user.upload(screen.getByLabelText('Upload QR image'), new File(['image'], 'empty.png', { type: 'image/png' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No QR code was found')
    expect(screen.queryByText('QR payment risk report')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review sandbox request' })).not.toBeInTheDocument()
  })
})
