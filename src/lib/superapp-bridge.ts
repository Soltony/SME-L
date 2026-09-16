'use client';

/**
 * Hand-off from the borrower app to the native super-app shell.
 *
 * The gateway answers a repayment request with a payment token that the host
 * app needs in order to raise the customer's PIN prompt; until the webview
 * passes it across the JS channel nothing prompts the customer and no callback
 * ever arrives. Each super-app build exposes the channel differently, so the
 * known shapes are tried in order. The previous SME app posted
 * `{"token": "..."}` to `window.myJsChannel`; GuessLow posted the bare token to
 * `window.MyJsChannel`. Both are supported, SME's first.
 */

const CHANNELS = [process.env.NEXT_PUBLIC_SUPERAPP_CHANNEL || 'myJsChannel', 'MyJsChannel'];

export interface HandoffResult {
  delivered: boolean;
  via: string | null;
}

type Channel = { postMessage?: (message: string) => void };
type HostWindow = Window & {
  [key: string]: unknown;
  webkit?: { messageHandlers?: Record<string, Channel> };
  flutter_inappwebview?: { callHandler?: (name: string, message: string) => void };
  ReactNativeWebView?: Channel;
};

export function requestWalletApproval(paymentToken: string): HandoffResult {
  if (typeof window === 'undefined') return { delivered: false, via: null };
  const w = window as unknown as HostWindow;
  const envelope = JSON.stringify({ token: paymentToken });

  for (const name of [...new Set(CHANNELS)]) {
    const payload = name === 'MyJsChannel' ? paymentToken : envelope;
    try {
      const channel = w[name] as Channel | undefined;
      if (typeof channel?.postMessage === 'function') {
        channel.postMessage(payload);
        return { delivered: true, via: `${name}.postMessage` };
      }
      const webkit = w.webkit?.messageHandlers?.[name];
      if (typeof webkit?.postMessage === 'function') {
        webkit.postMessage(payload);
        return { delivered: true, via: `webkit.${name}` };
      }
      if (typeof w.flutter_inappwebview?.callHandler === 'function') {
        w.flutter_inappwebview.callHandler(name, payload);
        return { delivered: true, via: `flutter.${name}` };
      }
    } catch {
      // try the next shape
    }
  }
  if (typeof w.ReactNativeWebView?.postMessage === 'function') {
    w.ReactNativeWebView.postMessage(envelope);
    return { delivered: true, via: 'ReactNativeWebView' };
  }
  return { delivered: false, via: null };
}
