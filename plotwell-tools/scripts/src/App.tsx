import { Shell } from './components/Shell'
import { ScriptsTool } from './components/ScriptsTool'
import { useState } from 'react'
import { AuthModal } from './components/AuthModal'

export default function App() {
  const [showAuth, setShowAuth] = useState(false)

  return (
    <>
      <Shell onLoginClick={() => setShowAuth(true)}>
        <ScriptsTool />
      </Shell>

      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => setShowAuth(false)}
        />
      )}
    </>
  )
}
