declare module 'koffi' {
  interface NativeType {
    readonly size: number
  }

  interface NativeFunction {
    (...args: unknown[]): unknown
    async(...args: unknown[]): void
  }

  interface Library {
    func(convention: string, name: string, result: unknown, parameters: unknown[]): NativeFunction
  }

  export interface KoffiModule {
    load(path: string): Library
    pointer(type: unknown): NativeType
    array(type: unknown, length: number): NativeType
    struct(name: string, fields: Readonly<Record<string, unknown>>): NativeType
    alloc(type: unknown, length: number): unknown
    encode(pointer: unknown, type: unknown, value: unknown): void
    decode(pointer: unknown, type: unknown): unknown
  }
}
