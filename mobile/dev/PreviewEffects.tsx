import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { EffectSwatch, Nameplate, NAMEPLATES, PROFILE_EFFECTS } from '../src/platina/Effects';
export default function Preview() {
  return <ScrollView style={{ backgroundColor: '#06070A' }} contentContainerStyle={{ padding: 16, gap: 14 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{PROFILE_EFFECTS.map(e => <View key={e.id} style={{ alignItems: 'center', gap: 4 }}><EffectSwatch effect={e.id} size={110} /><Text style={{ color: '#aab' }}>{e.label}</Text></View>)}</View>
    {NAMEPLATES.map(p => <View key={p.id} style={{ height: 52, borderRadius: 14, overflow: 'hidden', backgroundColor: '#12141a', justifyContent: 'center', paddingLeft: 14 }}><Nameplate plate={p.id} radius={14} /><Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>stage · {p.label}</Text></View>)}
  </ScrollView>;
}
