import { useState } from 'react'
import { Shell } from './components/Shell'
import { StoryboardTool } from './components/StoryboardTool'
import { AuthModal } from './components/AuthModal'

export default function App() {
  const [showAuth, setShowAuth] = useState(false)
  return (
    <>
      <Shell onLoginClick={() => setShowAuth(true)}>
        <StoryboardTool />
      </Shell>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={() => setShowAuth(false)} />}
    </>
  )
}
