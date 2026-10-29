const { withAndroidManifest, createRunOncePlugin } = require('expo/config-plugins');

// Download is requested explicitly through prepareBackground(). Do not add an
// install-time download flag: simply opening a chat must not fetch this model.
function withLinePhoto(config) {
  return withAndroidManifest(config, value => {
    const app = value.modResults.manifest.application?.[0];
    if (!app) throw new Error('Cannot locate Android application for LineaPhoto.');
    const entries = app['meta-data'] || [];
    const key = 'com.google.mlkit.vision.DEPENDENCIES';
    app['meta-data'] = entries.flatMap(entry => {
      if (entry.$?.['android:name'] !== key) return [entry];
      const models = (entry.$['android:value'] || '').split(',').map(x => x.trim()).filter(x => x && x !== 'subject_segment');
      return models.length ? [{...entry, $:{...entry.$, 'android:value':models.join(',')}}] : [];
    });
    return value;
  });
}
module.exports = createRunOncePlugin(withLinePhoto, 'linea-photo', '0.5.0');
