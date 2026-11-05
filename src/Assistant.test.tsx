import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import Assistant from './Assistant'

const recipient = {
  id: 'recipient-1',
  name: 'Shop',
  identifier: 'shop@upi',
  recipient_type: 'merchant',
  is_verified: false,
}

const proposal = {
  proposal_id: 'proposal-1',
  confirmation_token: 'confirmation-token-1',
  expires_at: '2026-08-03T00:10:00+00:00',
  action: 'prepare_universal_payment',
  message: 'Review the QR payment request.',
  recipient: 'Shop',
  rule_id: null,
  amount: 500,
  maximum_limit: null,
  currency: 'INR',
  frequency: null,
  payment_day: null,
  start_date: null,
  reminder_due_date: null,
  recipient_id: recipient.id,
  payment_category: 'qr_payment',
  purpose: 'Purchase',
  payment_date: '2026-08-03',
  order_reference: null,
  recurrence: null,
  qr_recipient_identifier: null,
  missing_fields: ['qr_recipient_identifier'],
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }
}

describe('Payment assistant QR proposals', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sessionStorage.clear()
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/payment-recipients') return jsonResponse([recipient])
      if (url === '/api/assistant/interpret') {
        return jsonResponse({
          message: 'Review the QR payment request.',
          proposal,
          upcoming_payments: null,
        })
      }
      if (url === '/api/universal-payment-risk') {
        return jsonResponse({
          level: 'Medium',
          score: 15,
          evidence: [{ type: 'saved_recipient_unconfirmed', points: 15 }],
          recommended_action: 'Review the recipient.',
          duplicate_blocked: false,
        })
      }
      if (url === '/api/assistant/confirm') {
        return jsonResponse({
          action: 'prepare_universal_payment',
          result: { id: 'payment-1', status: 'prepared' },
        }, 200)
      }
      if (url === '/api/universal-payment-requests') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({
          id: 'payment-1',
          status: 'prepared',
          category: body.category,
          qr_recipient_identifier: body.qr_recipient_identifier,
        }, 201)
      }
      return jsonResponse({ detail: `Unexpected request ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID: () => 'assistant-idempotency-key' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('requires a valid decoded UPI ID, reassesses it, and saves only after explicit confirmation', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><Assistant /></MemoryRouter>)
    await screen.findByText('Payment assistant')

    await user.type(screen.getByLabelText('Message the payment assistant'), 'Prepare a QR payment to Shop')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    const upiInput = await screen.findByLabelText('Decoded UPI ID')
    const confirmButton = screen.getByRole('button', { name: 'Confirm and prepare request' })
    expect(confirmButton).toBeDisabled()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/universal-payment-requests')).toBe(false)

    await user.type(upiInput, 'shop@upi')
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/universal-payment-risk', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"qr_recipient_identifier":"shop@upi"'),
      }))
    })
    await user.click(confirmButton)

    await screen.findByText(/Payment request prepared after your confirmation/)
    const confirmedCall = fetchMock.mock.calls.find(([url]) => url === '/api/assistant/confirm')
    expect(confirmedCall).toBeDefined()
    expect(JSON.parse(String(confirmedCall?.[1]?.body))).toEqual({
      proposal_id: 'proposal-1',
      confirmation_token: 'confirmation-token-1',
    })
  })
})
