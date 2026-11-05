/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#101a32',
        electric: '#4263eb',
        canvas: '#f6f7fb',
      },
    },
  },
  plugins: [],
}
