const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/react-native-webrtc');
if (JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version !== '150.1.1') throw new Error('Review screen capture patch for the new WebRTC version');
function edit(file, before, after) {
  const p = path.join(root,file), s = fs.readFileSync(p,'utf8');
  if (s.includes(after)) return;
  if (!s.includes(before)) throw new Error('Screen capture patch anchor changed: '+file);
  fs.writeFileSync(p,s.replace(before,after));
}
const android = 'android/src/main/java/com/oney/WebRTCModule/';
edit(android+'ScreenCaptureController.java','private static final int DEFAULT_FPS = 30;', 'private static final int DEFAULT_FPS = 60;');
edit(android+'WebRTCModuleOptions.java','public boolean enableMediaProjectionService;', 'public boolean enableMediaProjectionService = true;');
edit(android+'ScreenCaptureController.java','    @Override\n    public String getDeviceId()', `    // Linea: reserve the requested output size while preserving portrait orientation.
    @Override
    public void applyConstraints(com.facebook.react.bridge.ReadableMap constraints,
            @androidx.annotation.Nullable androidx.core.util.Consumer<Exception> callback) {
        try {
            int width = constraints.hasKey("width") ? constraints.getInt("width") : targetWidth;
            int height = constraints.hasKey("height") ? constraints.getInt("height") : targetHeight;
            if (width <= 0 || height <= 0 || width > 1920 || height > 1920) throw new IllegalArgumentException("Invalid screen dimensions");
            DisplayMetrics metrics = DisplayUtils.getDisplayMetrics((Activity) context);
            double scale = Math.min(1.0, (double)Math.max(width, height) / Math.max(metrics.widthPixels, metrics.heightPixels));
            targetWidth = Math.max(2, ((int)(metrics.widthPixels * scale) / 2) * 2);
            targetHeight = Math.max(2, ((int)(metrics.heightPixels * scale) / 2) * 2);
            targetFps = 60;
            actualWidth = targetWidth; actualHeight = targetHeight; actualFps = targetFps;
            videoCapturer.changeCaptureFormat(targetWidth, targetHeight, targetFps);
            if (callback != null) callback.accept(null);
        } catch (Exception error) { if (callback != null) callback.accept(error); }
    }

    @Override
    public String getDeviceId()`);
const ios='ios/RCTWebRTC/ScreenCaptureController.m';
edit(ios,'#import "SocketConnection.h"','#import "SocketConnection.h"\n#import <LiveKitWebRTC/RTCVideoSource.h>');
edit(ios,'- (NSDictionary *)getSettings {',`- (void)applyConstraints:(NSDictionary *)constraints error:(NSError **)outError {
    int width = [constraints[@"width"] intValue];
    int height = [constraints[@"height"] intValue];
    id source = self.capturer.delegate;
    if (width > 0 && height > 0 && [source isKindOfClass:[LKRTCVideoSource class]]) {
        (void)source; // Linea ReplayKit extension owns dimensions; sender limits output FPS.
    }
}

- (NSDictionary *)getSettings {`);
edit(ios,'@"frameRate" : @(30)', '@"frameRate" : @(60)');
// On rotation keep the size reserved by applyConstraints (same downscale and even rounding), so the
// listener compares like with like and does not jump back to full display resolution.
edit(android+'ScreenCaptureController.java',
 'final int width = displayMetrics.widthPixels;\n                final int height = displayMetrics.heightPixels;',
 'double scale = Math.min(1.0, (double)Math.max(targetWidth, targetHeight) / Math.max(displayMetrics.widthPixels, displayMetrics.heightPixels));\n                final int width = Math.max(2, ((int)(displayMetrics.widthPixels * scale) / 2) * 2);\n                final int height = Math.max(2, ((int)(displayMetrics.heightPixels * scale) / 2) * 2);');

// Cancelling before ReplayKit connects must not wait on an NSThread that has never started.
edit('ios/RCTWebRTC/SocketConnection.m',
    '    [self performSelector:@selector(unscheduleStreams) onThread:self.networkThread withObject:nil waitUntilDone:true];',
    '    if (self.networkThread.isExecuting) {\n        [self performSelector:@selector(unscheduleStreams) onThread:self.networkThread withObject:nil waitUntilDone:true];\n    }');
