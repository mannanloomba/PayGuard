export type PaymentCurrency = 'USD' | 'INR'

export function formatCurrency(amount: number, currency: PaymentCurrency = 'USD') {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).format(amount)
}
