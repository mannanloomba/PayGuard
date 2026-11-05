import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowLeftRight, Bot, CalendarDays,
  ChevronRight, CircleHelp, FileText,
  LayoutDashboard, Menu,
  Plus, ScanLine, Settings, Shield, ShieldCheck,
  TrendingDown, Wallet, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { formatCurrency } from './payment-format'
import { apiFetch } from './api-client'
import Assistant from './Assistant'
import BillRecognition from './BillRecognition'
import Payments from './Payments'
import ScanPay from './ScanPay'

type NavItem = { label: string; path: string; icon: LucideIcon }

const mainNav: NavItem[] = [
  { label: 'Overview', path: '/', icon: LayoutDashboard },
  { label: 'Bills', path: '/bills', icon: FileText },
  { label: 'Payments', path: '/payments', icon: ArrowLeftRight },
  { label: 'Scan & Pay', path: '/scan-pay', icon: ScanLine },
]
const moneyNav: NavItem[] = [
  { label: 'Security', path: '/security', icon: ShieldCheck },
  { label: 'Expenses', path: '/expenses', icon: TrendingDown },
  { label: 'Transactions', path: '/transactions', icon: Wallet },
]
const otherNav: NavItem[] = [
  { label: 'AI Assistant', path: '/assistant', icon: Bot },
  { label: 'Settings', path: '/settings', icon: Settings },
]

function Logo() {
  return (
    <div className="flex items-center gap-3 px-2">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-electric text-white shadow-lg shadow-blue-950/20">
        <Shield size={20} strokeWidth={2.2} />
      </div>
      <span className="text-[19px] font-semibold tracking-tight text-white">payguard</span>
    </div>
  )
}

type BackendStatus = {
  status: string
  database: string
  demo_mode: boolean
  demo_label: string
  assistant: string
  bill_extraction: string
  document_ocr: string
  payment_execution: string
}

function SettingsPage() {
  const [status, setStatus] = useState<BackendStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getApiData<BackendStatus>('/api/health')
      .then(setStatus)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not load backend status.'))
  }, [])

  const rows: [string, string][] = status ? [
    ['Backend', status.status],
    ['Database', status.database],
    ['BharatCode assistant', status.assistant],
    ['BharatCode bill extraction', status.bill_extraction],
    ['Local OCR', status.document_ocr],
    ['Payment execution', status.payment_execution],
  ] : []

  return (
    <div className="page-enter max-w-3xl space-y-5">
      <section className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-card sm:p-8">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Application configuration</h2>
        <p className="mt-2 text-sm text-slate-500">Runtime status only. Secret values are never returned to the browser.</p>
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</p>}
        {!status && !error && <div className="mt-5 h-24 animate-pulse rounded-xl bg-slate-100" />}
        {status && <dl className="mt-5 divide-y divide-slate-100">{rows.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-2 py-3">
            <dt className="text-sm text-slate-600">{label}</dt>
            <dd className="text-sm font-medium text-slate-800">{value.replace(/_/g, ' ')}</dd>
          </div>
        ))}</dl>}
        {status && (
          <div className={`mt-5 rounded-xl border p-4 text-xs leading-relaxed ${status.demo_mode ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
            <p className="font-semibold">{status.demo_mode ? 'FICTIONAL DEMO DATA · ISOLATED DATABASE' : 'Demo data is not active in this backend'}</p>
            <p className="mt-1">{status.demo_mode
              ? 'The backend is connected to backend\\payguard-demo.sqlite3. Records are fictional and sandbox-only.'
              : 'Load examples into the separate backend\\payguard-demo.sqlite3 database; your configured local database is not changed.'}</p>
            <p className="mt-3 font-medium">From the project root:</p>
            <code className="mt-1 block break-all">backend\.venv\Scripts\python.exe backend\seed_demo_data.py seed</code>
            <code className="mt-1 block break-all">backend\.venv\Scripts\python.exe backend\seed_demo_data.py verify</code>
            <code className="mt-1 block break-all">backend\.venv\Scripts\python.exe backend\seed_demo_data.py reset --confirm</code>
            <p className="mt-2">Restart the backend with <code>PAYGUARD_DATABASE_PATH</code> set to <code>backend\payguard-demo.sqlite3</code> to browse the demo. Reset removes only records owned by this seed dataset.</p>
          </div>
        )}
        <p className="mt-5 rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs leading-relaxed text-blue-900">
          Configure <code>BHARATCODE_API_KEY</code>, <code>BHARATCODE_BASE_URL</code>, and <code>BHARATCODE_MODEL</code> in the backend environment. Bill documents are OCR-processed locally; only extracted text is sent to BharatCode.
        </p>
      </section>
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [demoMode, setDemoMode] = useState(false)
  useEffect(() => {
    getApiData<BackendStatus>('/api/health')
      .then((status) => setDemoMode(status.demo_mode))
      .catch(() => setDemoMode(false))
  }, [])
  const groups = [
    { title: 'WORKSPACE', items: mainNav },
    { title: 'YOUR MONEY', items: moneyNav },
    { title: 'MORE', items: otherNav },
  ]
  return (
    <>
      {open && <button aria-label="Close navigation" onClick={onClose} className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden" />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col bg-navy px-4 pb-4 pt-6 text-slate-300 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="mb-9 flex items-center justify-between">
          <Logo />
          <button onClick={onClose} aria-label="Close menu" className="rounded-lg p-2 text-slate-400 hover:bg-white/10 lg:hidden"><X size={19} /></button>
        </div>
        <div className="mb-8 flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-left">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-400/20 text-xs font-semibold text-indigo-200">PG</div>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-white">{demoMode ? 'FICTIONAL DEMO DATA' : 'PayGuard AI local'}</span><span className="mt-0.5 block text-xs text-slate-400">{demoMode ? 'Isolated · sandbox only' : 'No bank connected'}</span></span>
        </div>
        <nav className="flex-1 space-y-7 overflow-y-auto" aria-label="Main navigation">
          {groups.map((group) => (
            <section key={group.title}>
              <p className="mb-2 px-3 text-[10px] font-semibold tracking-[.15em] text-slate-500">{group.title}</p>
              <div className="space-y-1">
                {group.items.map(({ label, path, icon: Icon }) => (
                  <NavLink key={path} to={path} end={path === '/'} onClick={onClose} className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}>
                    <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
                  </NavLink>
                ))}
              </div>
            </section>
          ))}
        </nav>
        <div className="mt-5 rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-white"><ShieldCheck size={15} className="text-blue-300" /> Payment safety</div>
          <p className="text-[11px] leading-relaxed text-slate-400">No bank connection or real payment provider is configured.</p>
          <NavLink to="/security" onClick={onClose} className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-blue-300 hover:text-blue-200">View security <ChevronRight size={13} /></NavLink>
        </div>
        <div className="flex items-center justify-between px-2 pt-5 text-[10px] text-slate-500"><span>© 2026 PayGuard</span><NavLink to="/assistant" aria-label="Open payment assistant"><CircleHelp size={15} /></NavLink></div>
      </aside>
    </>
  )
}

function Header({ onMenu }: { onMenu: () => void }) {
  const location = useLocation()
  const page = [...mainNav, ...moneyNav, ...otherNav].find((item) => item.path === location.pathname)?.label ?? 'Overview'
  return (
    <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-slate-200/80 bg-white/90 px-5 backdrop-blur-md sm:px-8 lg:px-10">
      <div className="flex items-center gap-3">
        <button onClick={onMenu} aria-label="Open navigation" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"><Menu size={20} /></button>
        <div><p className="text-[11px] font-medium text-slate-400">Workspace <span className="px-1">/</span> <span className="text-slate-600">{page}</span></p><h1 className="mt-0.5 text-[17px] font-semibold tracking-tight text-slate-900">{page}</h1></div>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <NavLink to="/transactions" aria-label="View payment request history" className="hidden h-9 w-9 place-items-center rounded-xl text-slate-500 hover:bg-slate-100 sm:grid"><ArrowLeftRight size={18} /></NavLink>
        <NavLink to="/payments" aria-label="View payment schedule" className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 hover:bg-slate-100"><CalendarDays size={18} /></NavLink>
        <div className="hidden h-7 w-px bg-slate-200 sm:block" />
        <div className="flex items-center gap-2.5"><div className="grid h-9 w-9 place-items-center rounded-full bg-[#e6ecff] text-xs font-semibold text-[#4056b4]">PG</div><div className="hidden sm:block"><p className="text-xs font-semibold text-slate-800">PayGuard AI</p><p className="text-[10px] text-slate-400">Local sandbox</p></div></div>
      </div>
    </header>
  )
}

function SectionHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">{title}</h2>{action && onAction && <button onClick={onAction} className="text-xs font-medium text-electric hover:text-blue-700">{action}</button>}</div>
}

type DashboardBill = {
  id: string
  provider_name: string | null
  bill_amount: number | null
  currency: 'USD' | 'INR' | null
  due_date: string | null
  risk: { level: 'Low' | 'Medium' | 'High'; score: number }
}
type DashboardRule = { id: string }
type DashboardSchedule = { recipient: string; payment_date: string; status: string }
type DashboardPayment = {
  id: string
  category: string
  recipient: string
  amount: number
  currency: 'USD' | 'INR'
  status: string
  payment_date: string
  purpose: string
}
type DashboardUniversalPayment = DashboardPayment & {
  risk: { level: string; score: number }
  recurrence: string | null
}

async function getApiData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json() as { detail?: string }
      if (body.detail) message = body.detail
    } catch {
      // Keep the HTTP status when the server does not return JSON.
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

function Overview() {
  const navigate = useNavigate()
  const [bills, setBills] = useState<DashboardBill[]>([])
  const [rules, setRules] = useState<DashboardRule[]>([])
  const [schedule, setSchedule] = useState<DashboardSchedule[]>([])
  const [payments, setPayments] = useState<DashboardPayment[]>([])
  const [universalPayments, setUniversalPayments] = useState<DashboardUniversalPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([
      getApiData<DashboardBill[]>('/api/bills'),
      getApiData<DashboardRule[]>('/api/payments/rules'),
      getApiData<DashboardSchedule[]>('/api/payments/schedule'),
      getApiData<DashboardPayment[]>('/api/transactions'),
      getApiData<DashboardUniversalPayment[]>('/api/universal-payment-requests'),
    ]).then(([savedBills, savedRules, upcoming, transactions, universalRequests]) => {
      if (!active) return
      setBills(savedBills)
      setRules(savedRules)
      setSchedule(upcoming)
      setPayments(transactions)
      setUniversalPayments(universalRequests)
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load financial safety data.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  const highRiskBills = bills.filter((bill) => bill.risk.level === 'High').length
  const highRiskPayments = universalPayments.filter((payment) => payment.risk.level === 'High').length
  const preparedPayments = payments.filter((payment) => payment.status === 'prepared' || payment.status === 'pending').length
  const successfulPayments = payments.filter((payment) => payment.status === 'succeeded')
  const latestBills = bills.slice(0, 5)
  const recentPayments = payments.slice(0, 5)
  const upcomingTransfers = universalPayments.filter(
    (payment) => payment.status === 'prepared' && payment.payment_date > new Date().toISOString().slice(0, 10),
  ).slice(0, 5)
  const subscriptionExpenses = universalPayments.filter(
    (payment) => payment.category === 'subscription' && payment.status === 'succeeded',
  )
  const spendingByCategory = successfulPayments.reduce(
    (totals, payment) => {
      const key = `${payment.category}|${payment.currency}`
      totals.set(key, (totals.get(key) ?? 0) + payment.amount)
      return totals
    },
    new Map<string, number>(),
  )
  const spendByCurrency = (items: DashboardPayment[]) => (['INR', 'USD'] as const)
    .map((currency) => ({
      currency,
      amount: items.filter((item) => item.currency === currency).reduce((sum, item) => sum + item.amount, 0),
    }))
    .filter((item) => item.amount > 0)

  return (
    <div className="page-enter space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-slate-500">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
          <h2 className="mt-1 text-[25px] font-semibold tracking-tight text-slate-900">Payment safety overview</h2>
          <p className="mt-1 text-sm text-slate-500">Payments across transfers, merchants, bills, subscriptions, and sandbox requests.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => navigate('/payments')} className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-xl bg-electric px-4 text-sm font-medium text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700"><Plus size={17} /> Send Money</button>
          <button onClick={() => navigate('/bills')} className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"><FileText size={16} /> Review a bill</button>
        </div>
      </div>

      <div role="note" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
        PayGuard is not connected to a bank or live payment provider. Sandbox approvals never move real money.
      </div>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">Completed outgoing payments</p>
          <p className="mt-4 text-lg font-semibold tracking-tight text-slate-900">{error ? '—' : loading ? '…' : spendByCurrency(successfulPayments).length ? spendByCurrency(successfulPayments).map((item) => formatCurrency(item.amount, item.currency)).join(' · ') : 'None recorded'}</p>
          <p className="mt-2 text-xs text-slate-400">Sandbox records, not bank activity</p>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">Incoming payments</p>
          <p className="mt-4 text-lg font-semibold tracking-tight text-slate-900">No records</p>
          <p className="mt-2 text-xs text-slate-400">No bank connection or incoming feed</p>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">Spending subscriptions</p>
          <p className="mt-4 text-lg font-semibold tracking-tight text-slate-900">{error ? '—' : loading ? '…' : spendByCurrency(subscriptionExpenses).length ? spendByCurrency(subscriptionExpenses).map((item) => formatCurrency(item.amount, item.currency)).join(' · ') : 'None recorded'}</p>
          <p className="mt-2 text-xs text-slate-400">{subscriptionExpenses.length} successful sandbox records</p>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">Recurring rules</p>
          <p className="mt-4 text-[25px] font-semibold tracking-tight text-slate-900">{error ? '—' : loading ? '…' : rules.length}</p>
          <p className="mt-2 text-xs text-slate-400">Schedule previews only</p>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">Pending approvals</p>
          <p className="mt-4 text-[25px] font-semibold tracking-tight text-slate-900">{error ? '—' : loading ? '…' : preparedPayments}</p>
          <button onClick={() => navigate('/transactions')} className="mt-2 text-xs font-medium text-electric">Review payment history</button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <SectionHeading title="Saved bill risk review" action="Open bills" onAction={() => navigate('/bills')} />
          {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : error ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">Saved bill data is unavailable.</p>
          ) : latestBills.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No bills saved yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {latestBills.map((bill) => (
                <div key={bill.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-slate-800">{bill.provider_name || 'Unknown provider'}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{bill.due_date || 'Due date missing'} · {bill.bill_amount !== null ? `${bill.currency ?? ''} ${bill.bill_amount.toFixed(2)}` : 'Amount missing'}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium ${bill.risk.level === 'High' ? 'bg-rose-50 text-rose-700' : bill.risk.level === 'Medium' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{bill.risk.level} · {bill.risk.score}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <SectionHeading title={`Risk alerts · ${highRiskBills + highRiskPayments} high-risk signals`} action="Review risk" onAction={() => navigate('/security')} />
          {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : error ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">Risk data is unavailable.</p>
          ) : highRiskBills + highRiskPayments === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No high-risk signals in the saved history. This is not a guarantee of safety.</p>
          ) : (
            <p className="rounded-xl bg-amber-50 px-4 py-4 text-xs text-amber-900">{highRiskBills} saved bills and {highRiskPayments} universal payment requests have high-risk evidence. Risk signals are not fraud findings.</p>
          )}
        </section>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <SectionHeading title="Spending by category" action="All transactions" onAction={() => navigate('/transactions')} />
          {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : error ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">Spending data is unavailable.</p>
          ) : spendingByCategory.size === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No successful outgoing payment records yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {[...spendingByCategory.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, amount]) => {
                const [category, currency] = key.split('|')
                return (
                  <div key={key} className="flex items-center justify-between gap-3 py-3">
                    <p className="text-xs font-medium capitalize text-slate-700">{category.replace(/_/g, ' ')}</p>
                    <span className="text-xs font-semibold text-slate-900">{formatCurrency(amount, currency as 'USD' | 'INR')}</span>
                  </div>
                )
              })}
            </div>
          )}
          <p className="mt-2 text-[10px] text-slate-400">Successful local sandbox records only; not bank-confirmed spending.</p>
        </section>
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <SectionHeading title="Recent transfers and purchases" action="All transactions" onAction={() => navigate('/transactions')} />
          {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : recentPayments.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No payment history yet.</p>
          ) : <div className="divide-y divide-slate-100">{recentPayments.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 py-3">
              <div><p className="text-xs font-semibold text-slate-800">{item.recipient}</p><p className="mt-1 text-[11px] text-slate-500">{item.category.replace(/_/g, ' ')} · {item.payment_date} · {item.status.replace(/_/g, ' ')}</p></div>
              <span className="text-xs font-semibold text-slate-800">{formatCurrency(item.amount, item.currency)}</span>
            </div>
          ))}</div>}
        </section>
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
          <SectionHeading title="Upcoming scheduled transfers" action="Manage payments" onAction={() => navigate('/payments')} />
          {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : upcomingTransfers.length === 0 ? (
            schedule.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">No future prepared transfers.</p> : (
              <div className="divide-y divide-slate-100">{schedule.slice(0, 5).map((item, index) => (
                <div key={`${item.recipient}-${item.payment_date}-${index}`} className="flex items-center justify-between gap-3 py-3">
                  <div><p className="text-xs font-semibold text-slate-800">{item.recipient}</p><p className="mt-1 text-[11px] text-slate-500">{item.payment_date} · rule preview</p></div>
                  <span className="text-[10px] text-slate-500">{item.status.replace(/_/g, ' ')} · not a payment</span>
                </div>
              ))}</div>
            )
          ) : <div className="divide-y divide-slate-100">{upcomingTransfers.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 py-3">
              <div><p className="text-xs font-semibold text-slate-800">{item.recipient}</p><p className="mt-1 text-[11px] text-slate-500">{item.payment_date} · approval required</p></div>
              <span className="text-xs font-semibold text-slate-800">{formatCurrency(item.amount, item.currency)}</span>
            </div>
          ))}</div>}
        </section>
      </div>
      <div className="flex flex-wrap gap-3">
        <button onClick={() => navigate('/assistant')} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Ask BharatCode assistant</button>
        <button onClick={() => navigate('/payments')} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Payment recovery</button>
      </div>
    </div>
  )
}

type SecurityBill = {
  id: string
  provider_name: string | null
  risk: {
    level: 'Low' | 'Medium' | 'High'
    score: number
    evidence: { type: string; points: number; details?: unknown; fields?: string[] }[]
    recommended_action: string
  }
}
type SecurityRecipient = { provider_name: string; confirmed_at: string }
type SecurityPayment = {
  id: string
  recipient: string
  category: string
  amount: number
  currency: 'USD' | 'INR'
  status: string
  payment_date: string
  risk: {
    level: 'Low' | 'Medium' | 'High'
    score: number
    evidence: { type: string; points: number; details?: unknown }[]
  }
}

function SecurityPage() {
  const [bills, setBills] = useState<SecurityBill[]>([])
  const [recipients, setRecipients] = useState<SecurityRecipient[]>([])
  const [payments, setPayments] = useState<SecurityPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([
      getApiData<SecurityBill[]>('/api/bills'),
      getApiData<SecurityRecipient[]>('/api/recipients'),
      getApiData<SecurityPayment[]>('/api/universal-payment-requests'),
    ]).then(([savedBills, confirmedRecipients, paymentRequests]) => {
      if (!active) return
      setBills(savedBills)
      setRecipients(confirmedRecipients)
      setPayments(paymentRequests)
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load risk information.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  const flagged = bills.filter((bill) => bill.risk.evidence.length > 0)
  const highRisk = flagged.filter((bill) => bill.risk.level === 'High').length
  const flaggedPayments = payments.filter((payment) => payment.risk.evidence.length > 0)
  const highRiskPayments = flaggedPayments.filter((payment) => payment.risk.level === 'High').length

  return (
    <div className="page-enter space-y-6">
      <div>
        <p className="text-sm text-slate-500">Signals from saved bills, universal payment requests, and recipient confirmations.</p>
        <h2 className="mt-1 text-[25px] font-semibold tracking-tight text-slate-900">Risk and recipient review</h2>
      </div>
      <p role="note" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
        Risk flags are review signals, not proof of fraud. Recipient confirmation is your own attestation, not external bank verification. This demo has no account authentication.
      </p>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">Bills with risk evidence</p>
          <p className="mt-3 text-2xl font-semibold text-slate-900">{loading || error ? '—' : flagged.length}</p>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          <p className="text-xs font-medium text-slate-500">High-risk saved records</p>
          <p className="mt-3 text-2xl font-semibold text-slate-900">{loading || error ? '—' : highRisk + highRiskPayments}</p>
        </div>
      </div>
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        <SectionHeading title="Bill evidence" />
        {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : error ? (
          <p className="py-8 text-center text-xs text-slate-500">Risk data is unavailable.</p>
        ) : flagged.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">No risk evidence on saved bills. This is not a guarantee of safety.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {flagged.map((bill) => (
              <article key={bill.id} className="py-4 first:pt-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">{bill.provider_name || 'Unknown provider'}</p>
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">{bill.risk.level} · {bill.risk.score}/100</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {bill.risk.evidence.map((item, index) => (
                    <li key={`${item.type}-${index}`} className="text-xs text-slate-600">
                      {item.type.replace(/_/g, ' ')} · {item.points} points
                      {item.fields?.length ? ` · missing: ${item.fields.join(', ')}` : ''}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-500">{bill.risk.recommended_action}</p>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        <SectionHeading title={`Universal payment evidence · ${flaggedPayments.length} flagged, ${highRiskPayments} high-risk`} />
        {loading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : error ? (
          <p className="py-8 text-center text-xs text-slate-500">Payment risk data is unavailable.</p>
        ) : flaggedPayments.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">No risk evidence on saved universal payment requests. This is not a guarantee of safety.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {flaggedPayments.map((payment) => (
              <article key={payment.id} className="py-4 first:pt-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{payment.recipient}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{payment.category.replace(/_/g, ' ')} · {payment.payment_date} · {payment.status.replace(/_/g, ' ')}</p>
                  </div>
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">{payment.risk.level} · {payment.risk.score}/100</span>
                </div>
                <p className="mt-2 text-xs font-medium text-slate-700">{formatCurrency(payment.amount, payment.currency)}</p>
                <ul className="mt-2 space-y-1">
                  {payment.risk.evidence.map((item, index) => (
                    <li key={`${item.type}-${index}`} className="text-xs text-slate-600">{item.type.replace(/_/g, ' ')} · {item.points} points</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        <SectionHeading title="User-confirmed provider names" />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-100" /> : recipients.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">No provider names confirmed yet. You can confirm a provider from its saved bill.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recipients.map((recipient) => <li key={recipient.provider_name} className="py-3 text-sm text-slate-700">{recipient.provider_name}</li>)}
          </ul>
        )}
      </section>
    </div>
  )
}

type RecordBill = {
  id: string
  provider_name: string | null
  bill_amount: number | null
  currency: 'USD' | 'INR' | null
  due_date: string | null
  risk: { level: string; score: number }
}
type RecordPayment = {
  id: string
  category: string
  recipient: string
  amount: number
  currency: 'USD' | 'INR'
  status: string
  purpose: string
  payment_date: string
  provider_reference: string | null
  error_code: string | null
  execution_mode: string
}

type FinanceAnalytics = {
  current_month: string
  completed_payment_count: number
  monthly_spending: { currency: 'USD' | 'INR'; amount: number }[]
  category_spending: { category: string; currency: 'USD' | 'INR'; amount: number }[]
  monthly_trends: { month: string; currency: 'USD' | 'INR'; amount: number }[]
  merchant_spending: { recipient: string; currency: 'USD' | 'INR'; amount: number; count: number }[]
  subscription_spending: { currency: 'USD' | 'INR'; amount: number }[]
  budgets: {
    id: string
    category: string
    currency: 'USD' | 'INR'
    monthly_limit: number
    spent: number
    remaining: number
    percent_used: number
    over_budget: boolean
  }[]
}
type FinanceInsight = {
  title: string
  message: string
  evidence_ids: string[]
}

function RecordsPage({ mode }: { mode: 'expenses' | 'transactions' }) {
  const [bills, setBills] = useState<RecordBill[]>([])
  const [payments, setPayments] = useState<RecordPayment[]>([])
  const [analytics, setAnalytics] = useState<FinanceAnalytics | null>(null)
  const [insights, setInsights] = useState<FinanceInsight[]>([])
  const [insightLoading, setInsightLoading] = useState(false)
  const [insightError, setInsightError] = useState('')
  const [budgetCategory, setBudgetCategory] = useState('all')
  const [budgetCurrency, setBudgetCurrency] = useState<'INR' | 'USD'>('INR')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [budgetSaving, setBudgetSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [recipient, setRecipient] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')

  async function generateInsights() {
    setInsightLoading(true)
    setInsightError('')
    try {
      const result = await getApiData<{ insights: FinanceInsight[] }>('/api/finance/insights', { method: 'POST' })
      setInsights(result.insights)
      if (result.insights.length === 0) setInsightError('More saved payment history or a budget is needed for evidence-based insights.')
    } catch (insightLoadError) {
      setInsightError(insightLoadError instanceof Error ? insightLoadError.message : 'Could not generate finance insights.')
    } finally {
      setInsightLoading(false)
    }
  }

  async function saveBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const monthlyLimit = Number(budgetLimit)
    if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) return
    setBudgetSaving(true)
    setError('')
    try {
      const saved = await getApiData<FinanceAnalytics['budgets'][number]>('/api/finance/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: budgetCategory, currency: budgetCurrency, monthly_limit: monthlyLimit }),
      })
      setAnalytics((current) => current
        ? { ...current, budgets: [...current.budgets.filter((item) => item.id !== saved.id), saved] }
        : current)
      setBudgetLimit('')
    } catch (budgetError) {
      setError(budgetError instanceof Error ? budgetError.message : 'Could not save this budget.')
    } finally {
      setBudgetSaving(false)
    }
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const query = new URLSearchParams()
    if (category) query.set('category', category)
    if (status) query.set('status', status)
    if (recipient.trim()) query.set('recipient', recipient.trim())
    if (dateFrom) query.set('date_from', dateFrom)
    if (dateTo) query.set('date_to', dateTo)
    if (minAmount) query.set('min_amount', minAmount)
    if (maxAmount) query.set('max_amount', maxAmount)
    const request = mode === 'expenses'
      ? Promise.all([
        getApiData<RecordBill[]>('/api/bills'),
        getApiData<FinanceAnalytics>('/api/finance/analytics'),
      ]).then(([savedBills, savedAnalytics]) => {
        if (active) {
          setBills(savedBills)
          setAnalytics(savedAnalytics)
        }
      })
      : getApiData<RecordPayment[]>(`/api/transactions?${query.toString()}`).then((value) => { if (active) setPayments(value) })
    request.catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load this page.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [mode, refresh, category, status, recipient, dateFrom, dateTo, minAmount, maxAmount])

  return (
    <div className="page-enter space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{mode === 'expenses' ? 'Amounts parsed from saved bills; not payment totals.' : 'Prepared sandbox requests only; no bank activity is connected.'}</p>
          <h2 className="mt-1 text-[25px] font-semibold tracking-tight text-slate-900">{mode === 'expenses' ? 'Bill amounts and risk' : 'Payment request history'}</h2>
        </div>
        <button onClick={() => setRefresh((current) => current + 1)} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Refresh</button>
      </div>
      {mode === 'transactions' && <form onSubmit={(event) => { event.preventDefault(); setRefresh((current) => current + 1) }} className="grid gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-slate-600">Category<select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm"><option value="">All categories</option>{['person_to_person', 'merchant', 'qr_payment', 'scheduled_transfer', 'account_transfer', 'utility_bill', 'invoice', 'subscription', 'everyday'].map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}</select></label>
        <label className="text-xs font-medium text-slate-600">Status<select value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm"><option value="">All statuses</option>{['prepared', 'pending', 'succeeded', 'failed', 'refunded'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-xs font-medium text-slate-600">Recipient<input value={recipient} onChange={(event) => setRecipient(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" placeholder="Search recipient" /></label>
        <label className="text-xs font-medium text-slate-600">From date<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" /></label>
        <label className="text-xs font-medium text-slate-600">To date<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" /></label>
        <label className="text-xs font-medium text-slate-600">Minimum amount<input type="number" min="0" step="0.01" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" /></label>
        <label className="text-xs font-medium text-slate-600">Maximum amount<input type="number" min="0" step="0.01" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" /></label>
        <button type="submit" className="self-end rounded-lg bg-electric px-4 py-2.5 text-xs font-medium text-white hover:bg-blue-700">Apply filters</button>
      </form>}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</p>}
      {mode === 'expenses' && analytics && !error && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
              <p className="text-xs font-medium text-slate-500">This month’s completed sandbox spend</p>
              <p className="mt-3 text-lg font-semibold text-slate-900">
                {analytics.monthly_spending.length
                  ? analytics.monthly_spending.map((item) => formatCurrency(item.amount, item.currency)).join(' · ')
                  : 'None recorded'}
              </p>
              <p className="mt-2 text-[10px] text-slate-400">{analytics.current_month} · not bank activity</p>
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
              <p className="text-xs font-medium text-slate-500">Successful sandbox records</p>
              <p className="mt-3 text-2xl font-semibold text-slate-900">{analytics.completed_payment_count}</p>
              <p className="mt-2 text-[10px] text-slate-400">Across saved payment history</p>
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
              <p className="text-xs font-medium text-slate-500">Subscription spending this month</p>
              <p className="mt-3 text-lg font-semibold text-slate-900">
                {analytics.subscription_spending.length
                  ? analytics.subscription_spending.map((item) => formatCurrency(item.amount, item.currency)).join(' · ')
                  : 'None recorded'}
              </p>
              <p className="mt-2 text-[10px] text-slate-400">Successful subscription-category records</p>
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
              <p className="text-xs font-medium text-slate-500">Budgets tracked</p>
              <p className="mt-3 text-2xl font-semibold text-slate-900">{analytics.budgets.length}</p>
              <p className="mt-2 text-[10px] text-slate-400">Configure budgets through the finance API</p>
            </section>
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
              <SectionHeading title="Category spending this month" />
              {analytics.category_spending.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">No successful outgoing payment records for this month.</p>
              ) : <ul className="divide-y divide-slate-100">{analytics.category_spending.map((item) => (
                <li key={`${item.category}-${item.currency}`} className="flex items-center justify-between gap-3 py-3 text-xs">
                  <span className="capitalize text-slate-700">{item.category.replace(/_/g, ' ')}</span>
                  <strong className="text-slate-900">{formatCurrency(item.amount, item.currency)}</strong>
                </li>
              ))}</ul>}
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
              <SectionHeading title="Merchant spending this month" />
              {analytics.merchant_spending.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">No successful merchant purchases recorded this month.</p>
              ) : <ul className="divide-y divide-slate-100">{analytics.merchant_spending.map((item) => (
                <li key={`${item.recipient}-${item.currency}`} className="flex items-center justify-between gap-3 py-3 text-xs">
                  <span className="min-w-0"><span className="block truncate text-slate-700">{item.recipient}</span><span className="text-[10px] text-slate-400">{item.count} purchase{item.count === 1 ? '' : 's'}</span></span>
                  <strong className="shrink-0 text-slate-900">{formatCurrency(item.amount, item.currency)}</strong>
                </li>
              ))}</ul>}
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
              <SectionHeading title="Six-month spending trend" />
              <ul className="divide-y divide-slate-100">{analytics.monthly_trends.map((item) => (
                <li key={`${item.month}-${item.currency}`} className="flex items-center justify-between gap-3 py-2 text-xs">
                  <span className="text-slate-600">{item.month} · {item.currency}</span>
                  <strong className="text-slate-900">{formatCurrency(item.amount, item.currency)}</strong>
                </li>
              ))}</ul>
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
              <SectionHeading title="Monthly budget progress" />
              {analytics.budgets.length === 0 ? (
                <p className="pb-4 pt-2 text-center text-xs text-slate-500">No budgets configured yet.</p>
              ) : <ul className="space-y-4">{analytics.budgets.map((budget) => (
                <li key={budget.id}>
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="capitalize text-slate-700">{budget.category.replace(/_/g, ' ')}</span>
                    <span className={budget.over_budget ? 'font-semibold text-rose-700' : 'text-slate-600'}>
                      {formatCurrency(budget.spent, budget.currency)} / {formatCurrency(budget.monthly_limit, budget.currency)}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${budget.over_budget ? 'bg-rose-500' : 'bg-electric'}`} style={{ width: `${Math.min(budget.percent_used, 100)}%` }} />
                  </div>
                </li>
              ))}</ul>}
              <form onSubmit={(event) => void saveBudget(event)} className="mt-5 grid gap-2 border-t border-slate-100 pt-4 sm:grid-cols-2">
                <label className="text-[11px] font-medium text-slate-600">Category
                  <select value={budgetCategory} onChange={(event) => setBudgetCategory(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs">
                    <option value="all">All spending</option>
                    {['person_to_person', 'merchant', 'qr_payment', 'scheduled_transfer', 'account_transfer', 'utility_bill', 'invoice', 'subscription', 'everyday'].map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}
                  </select>
                </label>
                <label className="text-[11px] font-medium text-slate-600">Currency
                  <select value={budgetCurrency} onChange={(event) => setBudgetCurrency(event.target.value as 'INR' | 'USD')} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs"><option value="INR">INR</option><option value="USD">USD</option></select>
                </label>
                <label className="text-[11px] font-medium text-slate-600 sm:col-span-2">Monthly limit
                  <input aria-label="Monthly budget limit" type="number" min="0.01" step="0.01" required value={budgetLimit} onChange={(event) => setBudgetLimit(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-xs" />
                </label>
                <button disabled={budgetSaving} className="rounded-lg bg-electric px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 sm:col-span-2">{budgetSaving ? 'Saving…' : 'Save monthly budget'}</button>
              </form>
            </section>
          </div>
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="text-sm font-semibold text-slate-900">BharatCode spending insights</h3><p className="mt-1 text-xs text-slate-500">Generated from saved aggregate spending and budget evidence only.</p></div>
              <button type="button" disabled={insightLoading} onClick={() => void generateInsights()} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">{insightLoading ? 'Analyzing…' : 'Generate insights'}</button>
            </div>
            {insightError && <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{insightError}</p>}
            {insights.length > 0 && <ul className="mt-4 divide-y divide-slate-100">{insights.map((insight) => (
              <li key={insight.title} className="py-3 first:pt-0"><p className="text-xs font-semibold text-slate-800">{insight.title}</p><p className="mt-1 text-xs leading-relaxed text-slate-600">{insight.message}</p><p className="mt-1 text-[10px] text-slate-400">Evidence: {insight.evidence_ids.join(', ')}</p></li>
            ))}</ul>}
          </section>
        </div>
      )}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card sm:p-6">
        {loading ? <div className="h-28 animate-pulse rounded-xl bg-slate-100" /> : mode === 'expenses' ? (
          bills.length === 0 ? <p className="py-10 text-center text-xs text-slate-500">No saved bill amounts to summarize.</p> : (
            <div className="space-y-4">
              <p className="text-xs text-slate-500">{bills.length} saved bills · amounts below are bills, not confirmed expenses or payments.</p>
              <div className="divide-y divide-slate-100">
                {bills.map((bill) => (
                  <div key={bill.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div><p className="text-sm font-medium text-slate-800">{bill.provider_name || 'Unknown provider'}</p><p className="mt-1 text-xs text-slate-500">{bill.due_date || 'Due date missing'} · Risk {bill.risk.level} ({bill.risk.score}/100)</p></div>
                    <p className="text-sm font-semibold text-slate-900">{bill.bill_amount !== null && bill.currency ? formatCurrency(bill.bill_amount, bill.currency) : 'Amount missing'}</p>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : payments.length === 0 ? <p className="py-10 text-center text-xs text-slate-500">No transactions match these filters. Payments are local sandbox records, not bank activity.</p> : (
          <div className="divide-y divide-slate-100">
            {payments.map((payment) => (
              <div key={payment.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div><p className="text-sm font-medium text-slate-800">{payment.recipient}</p><p className="mt-1 text-xs capitalize text-slate-500">{payment.category.replace(/_/g, ' ')} · {payment.payment_date} · {payment.purpose}</p><p className="mt-1 text-xs text-slate-500">{payment.status === 'succeeded' ? 'Sandbox success only · not proof of provider payment' : payment.status === 'prepared' ? 'Prepared · not submitted' : payment.status === 'pending' ? 'Pending · not successful' : payment.status}</p>{payment.error_code && <p className="mt-1 text-xs text-rose-700">{payment.error_code}</p>}</div>
                <p className="text-sm font-semibold text-slate-900">{formatCurrency(payment.amount, payment.currency)}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  return <div className="min-h-screen bg-canvas text-slate-900 lg:flex"><Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} /><div className="min-w-0 flex-1"><Header onMenu={() => setSidebarOpen(true)} />  <main className="mx-auto max-w-[1500px] px-5 py-7 sm:px-8 sm:py-8 lg:px-10 lg:py-9"><Routes><Route path="/" element={<Overview />} /><Route path="/bills" element={<BillRecognition />} /><Route path="/payments" element={<Payments />} /><Route path="/scan-pay" element={<ScanPay />} /><Route path="/security" element={<SecurityPage />} /><Route path="/expenses" element={<RecordsPage mode="expenses" />} /><Route path="/transactions" element={<RecordsPage mode="transactions" />} /><Route path="/assistant" element={<Assistant />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<NotFound />} /></Routes></main></div></div>
}

function NotFound() {
  const navigate = useNavigate()
  return <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-card"><p className="text-sm font-medium text-slate-400">404 · Page not found</p><h2 className="mt-2 text-xl font-semibold">This page isn’t here.</h2><button onClick={() => navigate('/')} className="mt-5 text-sm font-medium text-electric">Back to overview</button></div>
}

export default App
