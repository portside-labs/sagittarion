import { useEffect } from 'react'
import { applyAccent } from './lib/theme'
import { useStore } from './store'
import { ConnectScreen } from './screens/ConnectScreen'
import { Workspace } from './screens/Workspace'
import { Toasts } from './components/Toasts'
import { ConfirmDialog } from './components/ConfirmDialog'
import { SettingsDialog } from './components/SettingsDialog'

export default function App() {
  const init = useStore((s) => s.init)
  const session = useStore((s) => s.session)
  const platform = useStore((s) => s.appInfo?.platform)

  // The accent follows the open connection's colour; white when it has none.
  useEffect(() => {
    applyAccent(session?.color)
  }, [session?.color])

  // The top rows leave room for the traffic lights on macOS.
  useEffect(() => {
    document.documentElement.classList.toggle('mac', platform === 'darwin')
  }, [platform])

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.body.classList.toggle('mac', platform === 'darwin')
  }, [platform])

  return (
    <>
      {session ? <Workspace key={session.sessionId} /> : <ConnectScreen />}
      <SettingsDialog />
      <ConfirmDialog />
      <Toasts />
    </>
  )
}
