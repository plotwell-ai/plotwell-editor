import { useState } from 'react'
import { Shell } from './components/Shell'
import { BudgetTool } from './components/BudgetTool'
import { AuthModal } from './components/AuthModal'

export default function App() {
  const [showAuth, setShowAuth] = useState(false)
  return (
    <>
      <Shell onLoginClick={() => setShowAuth(true)}>
        <BudgetTool />
      </Shell>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={() => setShowAuth(false)} />}
    </>
  )
}
