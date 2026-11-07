export interface CapturedEmail {
  sender: string;
  to: string;
  subject: string;
  contentType: string;
  html: string;
  attachments: { name: string; contentId: string; isInline: boolean; contentType: string; bytes: number }[];
  saveToSentItems: boolean;
}
export interface FakeGraph {
  url: string;
  port: number;
  captured: CapturedEmail[];
  stats: { tokenRequests: number; sendRequests: number; rejected: number };
  close(): Promise<void>;
}
export function startFakeGraph(port?: number, opts?: { clientId?: string; clientSecret?: string }): Promise<FakeGraph>;
