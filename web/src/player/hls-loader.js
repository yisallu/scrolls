// hls.js is 400 KB — a third of it would be the largest thing on a page that often
// never plays an HLS stream at all. So it is loaded on demand, once, the first time a
// source actually needs it. Safari plays HLS natively and never pays for it.

let loading = null;

export function ensureHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/hls.min.js";
    s.async = true;
    s.onload = () => resolve(window.Hls);
    s.onerror = () => {
      loading = null;
      reject(new Error("hls.js 加载失败"));
    };
    document.head.appendChild(s);
  });
  return loading;
}
