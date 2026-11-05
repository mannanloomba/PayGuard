import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }
}

const analytics = {
  current_month: '2026-11',
  completed_payment_count: 1,
  monthly_spending: [{ currency: 'INR', amount: 3500 }],
  category_spending: [{ category: 'merchant', currency: 'INR', amount: 3500 }],
  monthly_trends: [{ month: '2026-11', currency: 'INR', amount: 3500 }],
  merchant_spending: [{ recipient: 'Sample Store', currency: 'INR', amount: 3500, count: 1 }],
  subscription_spending: [],
  budgets: [],
}

describe('finance and security pages', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/health') {
        return jsonResponse({
          status: 'ok',
          database: 'SQLite',
          demo_mode: false,
          demo_label: 'standard_local',
          assistant: 'configured',
          bill_extraction: 'configured',
          document_ocr: 'ready',
          payment_execution: 'sandbox_only',
        })
      }
      if (path === '/api/bills') return jsonResponse([])
      if (path === '/api/finance/analytics') return jsonResponse(analytics)
      if (path === '/api/recipients') return jsonResponse([])
      if (path === '/api/universal-payment-requests') return jsonResponse([{
        id: 'risk-payment-1',
        recipient: 'Sample Store',
        category: 'merchant',
        amount: 3500,
        currency: 'INR',
        status: 'prepared',
        payment_date: '2026-11-05',
        risk: {
          level: 'High',
          score: 75,
          evidence: [{ type: 'new_recipient', points: 25 }],
        },
      }])
      if (path === '/api/finance/budgets' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { category: string; currency: string; monthly_limit: number }
        return jsonResponse({
          id: 'budget-1',
          category: body.category,
          currency: body.currency,
          monthly_limit: body.monthly_limit,
          spent: 0,
          remaining: body.monthly_limit,
          percent_used: 0,
          over_budget: false,
        })
      }
      if (path === '/api/finance/insights' && init?.method === 'POST') {
        return jsonResponse({ insights: [{ title: 'Merchant spending', message: 'A saved merchant payment exists.', evidence_ids: ['category-merchant-INR'] }] })
      }
      return jsonResponse({ detail: `Unexpected request ${path}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows API-backed payment analytics, saves budgets, and requests evidence-based insights', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/expenses']}><App /></MemoryRouter>)

    expect(await screen.findByText('Merchant spending this month')).toBeInTheDocument()
    expect(screen.getByText('Sample Store')).toBeInTheDocument()
    expect(screen.getByText('1 purchase')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Monthly budget limit'), '5000')
    await user.click(screen.getByRole('button', { name: 'Save monthly budget' }))
    expect(await screen.findByText(/₹0\.00\s*\/\s*₹5,000\.00/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/finance/budgets', expect.objectContaining({ method: 'PUT' }))

    await user.click(screen.getByRole('button', { name: 'Generate insights' }))
    expect(await screen.findByText('Merchant spending')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/finance/insights', expect.objectContaining({ method: 'POST' }))
  })

  it('displays risk evidence from universal payment requests on the Security page', async () => {
    render(<MemoryRouter initialEntries={['/security']}><App /></MemoryRouter>)
    expect(await screen.findByText('Universal payment evidence · 1 flagged, 1 high-risk')).toBeInTheDocument()
    expect(screen.getByText('new recipient · 25 points')).toBeInTheDocument()
    expect(screen.getByText('High-risk saved records')).toBeInTheDocument()
  })
})
