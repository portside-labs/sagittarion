import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applySyntax, applyTheme } from './lib/theme'
import { useStore } from './store'
import './fonts'
import './styles.css'

// The saved theme and code colours, before anything is painted.
const { theme, syntax } = useStore.getState().ui
applyTheme(theme)
applySyntax(syntax)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
