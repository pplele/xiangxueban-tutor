/**
 * 图片压缩：拍照答题卡动辄 3-6MB，后端限 2MB。
 * 用 canvas 等比缩到 maxEdge 以内、转 JPEG(0.85)，仍超则继续降质/降尺寸。
 * 返回 data URL（image/jpeg;base64）。
 * @param source 原始图片 Blob
 * @param maxBytes 压缩后目标字节上限
 * @param maxEdge 最长边像素上限
 * @returns 压缩后的 JPEG data URL
 */
export async function compressImage(
  source: Blob,
  maxBytes = 1.6 * 1024 * 1024,
  maxEdge = 2000,
): Promise<string> {
  let blob: Blob = await toJpegBlob(source, maxEdge, 0.85);
  let edge = maxEdge;
  let quality = 0.85;
  while (blob.size > maxBytes && (edge > 640 || quality > 0.5)) {
    if (quality > 0.55) {
      quality -= 0.12;
    } else {
      edge = Math.round(edge * 0.8);
      quality = 0.8;
    }
    blob = await toJpegBlob(source, edge, quality);
  }
  return await blobToDataUrl(blob);
}

/**
 * 将图片等比缩放到 maxEdge 内，白底绘制后按指定质量转成 JPEG Blob。
 * @param source 原始图片 Blob
 * @param maxEdge 最长边像素上限
 * @param quality JPEG 质量（0~1）
 * @returns 压缩后的 JPEG Blob
 */
async function toJpegBlob(source: Blob, maxEdge: number, quality: number): Promise<Blob> {
  let bitmap: ImageBitmap | HTMLImageElement;
  if ('createImageBitmap' in window) {
    bitmap = await createImageBitmap(source);
  } else {
    const url = URL.createObjectURL(source);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = url;
    });
    bitmap = img;
    URL.revokeObjectURL(url);
  }
  const w = 'width' in bitmap ? bitmap.width : 0;
  const h = 'height' in bitmap ? bitmap.height : 0;
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布初始化失败');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, cw, ch);
  if ('close' in bitmap) bitmap.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('图片压缩失败'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * 用 FileReader 将 Blob 读成 data URL。
 * @param blob 待读取的 Blob
 * @returns data URL 字符串
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}
