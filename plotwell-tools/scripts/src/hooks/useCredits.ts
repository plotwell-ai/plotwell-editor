import { useState, useEffect } from 'react'
import { getCreditsBalance } from '@/lib/api'
import { useAuth } from './useAuth'

export function useCredits() {
  const { user } = useAuth()
  const [balance, setBalance] = useState<number | null>(null)

  useEffect(() => {
    if (!user) {
      setBalance(null)
      return
    }
    getCreditsBalance()
      .then(({ balance }) => setBalance(balance))
      .catch(() => setBalance(null))
  }, [user])

  return { balance }
}
