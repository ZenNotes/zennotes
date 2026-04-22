declare module 'keytar' {
  export function getPassword(
    service: string,
    account: string
  ): Promise<string | null>
  export function setPassword(
    service: string,
    account: string,
    password: string
  ): Promise<void>
  export function deletePassword(
    service: string,
    account: string
  ): Promise<boolean>

  const keytar: {
    getPassword: typeof getPassword
    setPassword: typeof setPassword
    deletePassword: typeof deletePassword
  }

  export default keytar
}
