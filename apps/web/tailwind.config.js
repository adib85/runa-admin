/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Luxury black/white palette
        neutral: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0a',
        },
        // Accent - subtle gold for luxury feel
        accent: {
          50: '#fdfdf9',
          100: '#f9f7ed',
          200: '#f1edd4',
          300: '#e5ddb0',
          400: '#d4c67a',
          500: '#c4ae4f',
          600: '#b09339',
          700: '#8f7430',
          800: '#765d2c',
          900: '#634e28',
        }
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      boxShadow: {
        'subtle': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
        'soft': '0 2px 8px 0 rgb(0 0 0 / 0.04)',
        'medium': '0 4px 12px 0 rgb(0 0 0 / 0.06)',
      },
    },
  },
  plugins: [],
}
