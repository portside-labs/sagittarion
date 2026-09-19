import { useEffect } from 'react'
import { useStore } from './store'
import { ConnectScreen } from './screens/ConnectScreen'
import { Workspace } from './screens/Workspace'
import { Toasts } from './components/Toasts'
import { ConfirmDialog } from './components/ConfirmDialog'

export default function App() {
  const init = useStore((s) => s.init)
  const session = useStore((s) => s.session)
  const platform = useStore((s) => s.appInfo?.platform)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.body.classList.toggle('mac', platform === 'darwin')
  }, [platform])

  return (
    <>
      {session ? <Workspace key={session.sessionId} /> : <ConnectScreen />}
      <ConfirmDialog />
      <Toasts />
    </>
  )
}
