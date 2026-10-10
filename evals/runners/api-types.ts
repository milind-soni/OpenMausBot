export interface ApiClient {
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: any }>;
  patch(path: string, body?: unknown): Promise<{ status: number; body: any }>;
  put(path: string, body?: unknown): Promise<{ status: number; body: any }>;
  del(path: string): Promise<{ status: number; body: any }>;
}
