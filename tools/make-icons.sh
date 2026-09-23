#!/bin/sh
# ぼぶる のアプリアイコンを tools/icon.svg から作る（Mac 標準の機能だけ。追加の道具は不要）。
#   sh tools/make-icons.sh
set -e
cd "$(dirname "$0")/.."
for spec in "apple-touch-icon.png:180" "icon-192.png:192" "icon-512.png:512" "favicon-32.png:32"; do
  name=${spec%%:*}; size=${spec##*:}
  osascript -l JavaScript - "$PWD/tools/icon.svg" "$PWD/$name" "$size" <<'JS'
ObjC.import('Cocoa');
function run(argv){
  var img=$.NSImage.alloc.initWithContentsOfFile($(argv[0])); var n=parseInt(argv[2],10);
  var rep=$.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null,n,n,8,4,true,false,$.NSDeviceRGBColorSpace,0,0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0,0,n,n),$.NSZeroRect,$.NSCompositingOperationSourceOver,1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  var data=rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$());
  data.writeToFileAtomically($(argv[1]),true);
  return argv[1];
}
JS
done
echo "icons written"
