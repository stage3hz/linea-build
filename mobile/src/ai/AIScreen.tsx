import React, { useEffect, useRef, useState } from 'react';
import { ComposerInput } from '../ComposerInput';
import * as Crypto from 'expo-crypto';
import { KeyboardSafeView } from '../keyboard';
import type { AIHistoryStore, AIStoredConversation } from './history';
import { ActivityIndicator, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, Switch, View } from 'react-native';
import { Text, TextInput } from '../typography';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import type { Api } from '../api';
import { Button, Icon, IconButton, Notice, Sheet, type IconName } from '../components';
import { GlassStage, GlassSurface } from '../glass';
import { formatListTime, useTheme } from '../theme';
import { aiModels, aiQuestion, aiStatus } from './client';
import { AIMediaPanel, type MediaMode } from './AIMedia';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { AIConversation, AI_MESSAGE_LIMIT, CODE_TASK_PREFIX, codePreviewCurrent, createCodeTaskPreview, type AICapabilityName, type AIState, type AIStatus, type AITurn, type CodeTaskPreview } from './conversation';

const emptyState = (): AIState => ({ consent: false, turns: [], pending: false, error: '' });

function useAI(api: Api) {
  const [state, setState] = useState<AIState>(emptyState), [status, setStatus] = useState<AIStatus | null>(null);
  const [statusError, setStatusError] = useState(''), [checking, setChecking] = useState(true), [refreshKey, setRefreshKey] = useState(0);
  const conversation = useRef<AIConversation | null>(null);
  useEffect(() => {
    const owner = new AIConversation((messages, signal, options) => aiQuestion(api, messages, signal, options));
    conversation.current = owner; setState(owner.getSnapshot());
    const unsubscribe = owner.subscribe(() => setState(owner.getSnapshot()));
    return () => { unsubscribe(); if (conversation.current === owner) conversation.current = null; owner.close(); };
  }, [api]);
  useEffect(() => {
    let live = true;
    const request = new AbortController();
    setStatus(null); setChecking(true); setStatusError('');
    void aiStatus(api, request.signal).then(value => { if (live) setStatus(value); }).catch(error => {
      if (live) setStatusError(error instanceof Error ? error.message : 'Не удалось проверить доступность AI.');
    }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; request.abort(); };
  }, [api, refreshKey]);
  return { state, status, statusError, checking, conversation, refresh: () => setRefreshKey(value => value + 1) };
}

function AITurnView({ turn, retryable, canRetry, onRetry }: { turn: AITurn; retryable: boolean; canRetry: boolean; onRetry: () => void }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const code = turn.question.startsWith(CODE_TASK_PREFIX);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (!turn.answer) return;
    await Clipboard.setStringAsync(turn.answer.text);
    setCopied(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return <View style={{ gap: 10, marginBottom: 18 }}>
    <View style={{ alignSelf: 'flex-end', maxWidth: '92%', backgroundColor: t.bubble, padding: 14, borderRadius: 22, borderBottomRightRadius: 7, borderWidth: 1, borderColor: t.glassBorder, gap: 6 }}>{code ? <Text style={{ color: t.accent, fontSize: 10, fontWeight: '700' }}>Задача по коду</Text> : null}<Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>{code ? turn.question.slice(CODE_TASK_PREFIX.length) : turn.question}</Text></View>
    {turn.answer ? <GlassSurface radius={23} shadow={false} contentStyle={{ padding: 16, gap: 11 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name="sparkles-outline" size={17} color={t.accent} /><Text style={{ color: t.accent, fontWeight: '700', fontSize: 12 }}>AI</Text></View>
      <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 23 }}>{turn.answer.text}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ flex: 1, color: t.muted, fontSize: 10, lineHeight: 15 }}>Модель: {turn.answer.model}</Text><Pressable accessibilityRole="button" accessibilityLabel="Скопировать ответ AI" onPress={() => void copy()} style={{ padding: 8 }}><Icon name={copied ? 'checkmark' : 'copy-outline'} size={17} color={t.accent} /></Pressable></View>
    </GlassSurface> : turn.status === 'pending' ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12 }}><ActivityIndicator size="small" color={t.accent} /><Text style={{ color: t.muted, fontSize: 12 }}>AI готовит ответ…</Text></View> : <View style={{ paddingHorizontal: 8, gap: 8 }}>
      <Text style={{ color: turn.status === 'failed' ? t.danger : t.muted, fontSize: 12, lineHeight: 18 }}>{turn.status === 'cancelled' ? 'Ожидание ответа отменено.' : turn.error || 'Ответ не получен.'}</Text>
      {retryable ? <Button secondary label={code ? 'Повторить эту задачу' : 'Повторить этот вопрос'} icon="refresh-outline" disabled={!canRetry} onPress={onRetry} /> : null}
    </View>}
  </View>;
}

const tools: { key: AICapabilityName; label: string; icon: IconName }[] = [
  { key: 'image', label: 'Изображения', icon: 'image-outline' },
  { key: 'video', label: 'Видео', icon: 'videocam-outline' },
  { key: 'threeD', label: '3D', icon: 'cube-outline' },
  { key: 'social', label: 'Соцсети', icon: 'share-social-outline' },
];

function AIUnavailableTools({ status, checking }: { status: AIStatus | null; checking: boolean }) {
  const t = useTheme();
  return <View style={{ gap: 9 }}><Text style={{ color: t.muted, fontSize: 11, fontWeight: '600' }}>Другие AI-инструменты</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
    {tools.map(tool => {
      const capability = status?.capabilities[tool.key];
      const reason = checking ? 'Проверяем подключение…' : !status ? 'Доступность пока не подтверждена.' : capability?.enabled ? 'Этот инструмент пока не поддерживается этой версией приложения.' : capability?.reason || 'Инструмент пока не подключён.';
      return <View key={tool.key} accessibilityLabel={`${tool.label}: ${reason}`} style={{ flexBasis: '47%', flexGrow: 1, borderRadius: 19, padding: 13, gap: 8, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name={tool.icon} color={t.muted} size={20} /><Text style={{ color: t.text, fontSize: 12, fontWeight: '600' }}>{tool.label}</Text></View><Text style={{ color: t.muted, fontSize: 10, lineHeight: 15 }}>{reason}</Text><Text style={{ color: t.subtle, fontSize: 9 }}>Недоступно здесь</Text></View>;
    })}
  </View></View>;
}

function CodeApproval({ preview, allowed, onCancel, onApprove }: { preview: CodeTaskPreview | null; allowed: boolean; onCancel: () => void; onApprove: () => void }) {
  const t = useTheme();
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => setShowHistory(false), [preview]);
  return <Sheet visible={!!preview} title="Проверить задачу по коду" onClose={onCancel}><View style={{ gap: 13 }}>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>После подтверждения задача и контекст этой AI-беседы будут отправлены через твой сервер бесплатному поставщику модели. Результат — текст с кодом или объяснением. Запуск кода, изменение файлов и публикация в эту задачу не входят.</Text>
    <Text style={{ color: t.text, fontSize: 13, fontWeight: '700' }}>Точный текст текущего запроса</Text><Text selectable style={{ color: t.text, fontSize: 13, lineHeight: 20, padding: 13, backgroundColor: t.surface2, borderRadius: 15 }}>{preview?.prompt}</Text>
    {preview && preview.messages.length > 1 ? <><Button secondary label={`${showHistory ? 'Скрыть' : 'Показать'} контекст · ${preview.messages.length - 1} сообщений`} onPress={() => setShowHistory(!showHistory)} />{showHistory ? preview.messages.slice(0, -1).map((message, index) => <View key={index} style={{ gap: 4, padding: 12, borderRadius: 14, backgroundColor: t.surface2 }}><Text style={{ color: t.accent, fontSize: 10, fontWeight: '600' }}>{message.role === 'user' ? 'Твой предыдущий запрос' : 'Предыдущий ответ AI'}</Text><Text selectable style={{ color: t.text, fontSize: 12, lineHeight: 18 }}>{message.content}</Text></View>) : null}</> : <Text style={{ color: t.muted, fontSize: 11 }}>Предыдущий контекст не добавляется.</Text>}
    <Button label="Отправить эту задачу AI" icon="arrow-up-outline" disabled={!allowed} onPress={onApprove} />
    <Button secondary label="Вернуться к редактированию" onPress={onCancel} />
  </View></Sheet>;
}

const STRATEGY_HELP: Record<string, string> = { auto: 'Цепочка из панели FreeLLMAPI', 'auto:smart': 'Самые умные из доступных', 'auto:fast': 'Самые быстрые', 'auto:reliable': 'Самые стабильные', fusion: 'Несколько моделей отвечают, судья собирает лучший ответ' };
const modelLabel = (id: string) => ({ auto: 'Авто', 'auto:smart': 'Умная', 'auto:fast': 'Быстрая', 'auto:reliable': 'Надёжная', 'auto:balanced': 'Сбалансированная', fusion: 'Fusion — консилиум' } as Record<string, string>)[id] || id;

export function AIScreen({ api, onBack, quick = false, history }: { api: Api; onBack: () => void; quick?: boolean; history?: AIHistoryStore }) {
  const t = useTheme(), ai = useAI(api);
  const [conversationId, setConversationId] = useState(() => Crypto.randomUUID());
  const [historySheet, setHistorySheet] = useState(false);
  const restored = useRef(false);
  // Reopen the latest conversation once the encrypted history has loaded (not for the quick dialog).
  useEffect(() => {
    if (restored.current || !history?.loaded || !ai.conversation.current) return;
    restored.current = true;
    const latest = history.items[0];
    if (!quick && latest && !ai.conversation.current.getSnapshot().turns.length) { setConversationId(latest.id); ai.conversation.current.restore(latest.turns, latest.consent); }
  }, [history?.loaded, history?.items, quick, ai.conversation, ai.state]);
  useEffect(() => { if (history && !ai.state.pending && ai.state.turns.length) history.save(conversationId, ai.state.turns, ai.state.consent); }, [ai.state, conversationId, history?.save]);
  const [draft, setDraft] = useState(''), [mode, setMode] = useState<'text' | 'code' | MediaMode>('text'), [taskError, setTaskError] = useState('');
  const [model, setModel] = useState('auto'), [models, setModels] = useState<string[]>([]), [modelSheet, setModelSheet] = useState(false), [photo, setPhoto] = useState<string | null>(null);
  const router = ai.status?.provider === 'freellmapi';
  const media = mode !== 'text' && mode !== 'code';
  useEffect(() => { if (!router || !ai.status?.capabilities.models.enabled) return; const request = new AbortController(); aiModels(api, request.signal).then(result => setModels(result.models)).catch(() => {}); return () => request.abort(); }, [api, router, ai.status]);
  const attachPhoto = async () => {
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0]; const edge = Math.max(asset.width || 0, asset.height || 0);
      // Vision models resize anyway; 1280 px JPEG keeps the request small and drops metadata.
      const small = await ImageManipulator.manipulateAsync(asset.uri, edge > 1280 ? [{ resize: (asset.width || 0) >= (asset.height || 0) ? { width: 1280 } : { height: 1280 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: .82, base64: true });
      if (!small.base64 || small.base64.length > 5_000_000) throw new Error('Фото слишком большое для вопроса.');
      setPhoto(`data:image/jpeg;base64,${small.base64}`); setTaskError('');
    } catch (error) { setTaskError(error instanceof Error ? error.message : 'Не удалось подготовить фото.'); }
  };
  const [approval, setApproval] = useState<{ preview: CodeTaskPreview; owner: AIConversation } | null>(null);
  const list = useRef<ScrollView>(null);
  const ready = ai.status?.configured === true && ai.status.capabilities[mode].enabled, last = ai.state.turns.at(-1);
  const askOptions = () => router ? { ...(model !== 'auto' ? { model } : {}), ...(photo && mode === 'text' ? { image: photo } : {}) } : undefined;
  const inputLimit = mode === 'code' ? AI_MESSAGE_LIMIT - CODE_TASK_PREFIX.length : AI_MESSAGE_LIMIT;
  const canSend = ready && ai.state.consent && !ai.state.pending && !!draft.trim();
  const help = { color: t.muted, fontSize: 12, lineHeight: 18 };
  useEffect(() => { setDraft(''); setApproval(null); setTaskError(''); setMode('text'); }, [api]);
  function send() {
    if (!ready || !ai.conversation.current) return;
    const owner = ai.conversation.current;
    if (mode === 'code') {
      try { setApproval({ owner, preview: createCodeTaskPreview(owner.getSnapshot().turns, draft) }); setTaskError(''); }
      catch (error) { setTaskError(error instanceof Error ? error.message : 'Не удалось подготовить задачу.'); }
      return;
    }
    void owner.ask(draft, askOptions());
    if (owner.getSnapshot().pending) { setDraft(''); setPhoto(null); }
  }
  function approveCode() {
    const owner = ai.conversation.current;
    if (!approval || !owner || !ready || !ai.state.consent || approval.owner !== owner || !codePreviewCurrent(owner.getSnapshot().turns, approval.preview)) {
      setApproval(null); setTaskError('Беседа изменилась. Проверь задачу ещё раз перед отправкой.'); return;
    }
    void owner.ask(approval.preview.prompt, askOptions());
    if (owner.getSnapshot().pending) { setDraft(''); setApproval(null); setTaskError(''); }
  }
  function clear() { ai.conversation.current?.clear(); setConversationId(Crypto.randomUUID()); setDraft(''); setApproval(null); setTaskError(''); }
  function openConversation(item: AIStoredConversation) { ai.conversation.current?.restore(item.turns, item.consent); setConversationId(item.id); setDraft(''); setApproval(null); setTaskError(''); setHistorySheet(false); }
  return <KeyboardSafeView style={{ flex: 1, backgroundColor: 'transparent' }}>
    <GlassSurface radius={27} style={{ margin: 12, marginBottom: 7 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      <IconButton name={quick ? 'close' : 'chevron-back'} label={quick ? 'Закрыть быстрый вопрос AI' : 'Назад к чатам'} onPress={onBack} />
      <View style={{ flex: 1, gap: 3 }}><Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{quick ? 'Быстрый вопрос AI' : 'AI'}</Text><Text style={{ color: t.muted, fontSize: 11 }}>{ai.status?.provider === 'freellmapi' ? 'FreeLLMAPI · бесплатные модели' : 'OpenRouter · бесплатные модели'}</Text></View>
      {history ? <IconButton name="time-outline" label="История AI-бесед" onPress={() => setHistorySheet(true)} color={t.accent} /> : null}
      <IconButton name="add-circle-outline" label="Начать новую AI-беседу" onPress={clear} color={t.accent} disabled={!ai.state.turns.length && !draft} />
    </GlassSurface>
    <ScrollView ref={list} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 14, paddingTop: 4, paddingBottom: 20, width: '100%', maxWidth: 760, alignSelf: 'center', gap: 13 }} onContentSizeChange={() => { if (ai.state.pending || last?.status === 'complete') list.current?.scrollToEnd({ animated: true }); }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{([{ id: 'text', label: 'Вопрос', icon: 'chatbubble-ellipses-outline' }, { id: 'code', label: 'Код', icon: 'code-slash-outline' }, ...(router ? [{ id: 'image', label: 'Картинка', icon: 'image-outline' }, { id: 'video', label: 'Видео', icon: 'videocam-outline' }, { id: 'speech', label: 'Озвучка', icon: 'volume-high-outline' }, { id: 'transcribe', label: 'Аудио → текст', icon: 'mic-outline' }] : [])] as { id: 'text' | 'code' | MediaMode; label: string; icon: IconName }[]).map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: mode === item.id, disabled: ai.state.pending }} disabled={ai.state.pending} onPress={() => { setMode(item.id); setTaskError(''); }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 15, borderRadius: 18, backgroundColor: mode === item.id ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: mode === item.id ? t.accent : t.border }}><Icon name={item.icon} size={18} color={mode === item.id ? t.accent : t.muted} /><Text style={{ color: mode === item.id ? t.accent : t.text, fontSize: 13, fontWeight: '600' }}>{item.label}</Text></Pressable>)}</ScrollView>
      {router && !media ? <Pressable accessibilityRole="button" accessibilityLabel="Выбрать модель AI" onPress={() => setModelSheet(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border }}><Icon name="hardware-chip-outline" size={16} color={t.accent} /><Text style={{ color: t.text, fontSize: 12 }}>Модель: {modelLabel(model)}</Text><Icon name="chevron-down" size={14} color={t.muted} /></Pressable> : null}
      {mode === 'code' ? <Text style={help}>AI подготовит код или объяснение. Перед отправкой ты проверишь точную задачу и контекст. Выполнение кода здесь не подключено.</Text> : null}
      <GlassSurface radius={23} shadow={false} contentStyle={{ padding: 16, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1, gap: 4 }}><Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>Отправлять вопросы AI</Text><Text style={{ color: t.muted, fontSize: 11 }}>Разрешение только для этой беседы</Text></View><Switch accessibilityLabel="Отправлять вопросы внешней AI-службе" value={ai.state.consent} onValueChange={value => ai.conversation.current?.setConsent(value)} trackColor={{ false: t.subtle, true: t.accent }} thumbColor="#FFF" /></View>
        <Text style={help}>Вопросы и история этой AI-беседы передаются через твой сервер {ai.status?.provider === 'freellmapi' ? 'в сервис FreeLLMAPI на нём и бесплатному поставщику модели, которого он выберет' : 'в OpenRouter и поставщику модели'}. В AI попадает только текст, который ты пишешь здесь.</Text>
        <Text style={help}>{history ? 'История бесед хранится зашифрованной только на этом устройстве — открыть её можно кнопкой с часами вверху.' : 'В быстром вопросе история временная: она очищается при закрытии окна.'}</Text>
        {ai.status?.provider !== 'freellmapi' ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://openrouter.ai/privacy')} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}><Text style={{ color: t.accent, fontSize: 11 }}>Конфиденциальность OpenRouter</Text></Pressable> : null}
      </GlassSurface>
      {ai.checking ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 14 }}><ActivityIndicator color={t.accent} size="small" /><Text style={help}>Проверяем доступность AI…</Text></View> : ai.statusError ? <Notice text={ai.statusError} error onRetry={ai.refresh} /> : !ready ? <GlassSurface radius={23} shadow={false} contentStyle={{ padding: 18, gap: 12 }}><Icon name="sparkles-outline" color={t.muted} size={30} /><Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>AI пока не подключён на этом сервере</Text><Text style={help}>Когда администратор подключит сервис, здесь можно будет задать вопрос. Ответы появятся только после реального запроса.</Text><Button secondary label="Проверить снова" icon="refresh-outline" onPress={ai.refresh} /></GlassSurface> : !ai.state.turns.length ? <View style={{ padding: 10, gap: 12 }}><Text style={{ color: t.text, fontSize: 23, fontWeight: '700', letterSpacing: -.5 }}>Что хочешь узнать?</Text><Text style={help}>Задай короткий вопрос или начни с подсказки. Бесплатные модели могут быть временно недоступны.</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{['Объясни простыми словами ', 'Помоги составить план ', 'Предложи идеи для '].map(prompt => <Pressable key={prompt} accessibilityRole="button" onPress={() => setDraft(prompt)} style={{ paddingHorizontal: 12, paddingVertical: 11, borderRadius: 16, backgroundColor: t.accentSoft, borderWidth: 1, borderColor: t.border }}><Text style={{ color: t.accent, fontSize: 11, fontWeight: '600' }}>{prompt.trim()}…</Text></Pressable>)}</View></View> : null}
      {media && ready ? <AIMediaPanel api={api} mode={mode as MediaMode} consent={ai.state.consent} /> : null}
      {!ai.state.turns.length && !router ? <AIUnavailableTools status={ai.status} checking={ai.checking} /> : null}
      {ai.state.turns.map(turn => <AITurnView key={turn.id} turn={turn} retryable={turn.id === last?.id} canRetry={ready && ai.state.consent && !ai.state.pending} onRetry={() => void ai.conversation.current?.retry()} />)}
      {ai.state.error && ai.state.error !== last?.error ? <Notice text={ai.state.error} error /> : null}
      {taskError ? <Notice text={taskError} error /> : null}
    </ScrollView>
    {!media ? <GlassSurface radius={26} style={{ margin: 12, marginTop: 3 }} contentStyle={{ padding: 10, gap: 8 }}>
      {photo && mode === 'text' ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 6 }}><Image source={{ uri: photo }} style={{ width: 44, height: 44, borderRadius: 10 }} /><Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>Фото к вопросу</Text><IconButton name="close" label="Убрать фото" size={18} color={t.muted} onPress={() => setPhoto(null)} /></View> : null}
      {ai.state.pending ? <><Button secondary label="Отменить ожидание" icon="stop-outline" onPress={() => ai.conversation.current?.cancel()} /><Text style={{ color: t.muted, fontSize: 10, lineHeight: 15, textAlign: 'center' }}>Уже отправленный текст нельзя отозвать у внешней службы.</Text></> : <>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}><ComposerInput accessibilityLabel={mode === 'code' ? 'Задача по коду для AI' : 'Вопрос AI'} value={draft} onChangeText={setDraft} placeholder={mode === 'code' ? 'Опиши задачу по коду…' : 'Напиши вопрос…'} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} multiline maxLength={inputLimit} style={{ flex: 1, minHeight: 45, maxHeight: 140, padding: 10, color: t.text, fontSize: 15, lineHeight: 22 }} />
          {router && mode === 'text' && ai.status?.capabilities.vision.enabled ? <IconButton name="image-outline" label="Прикрепить фото к вопросу" onPress={() => void attachPhoto()} color={t.muted} size={24} style={{ width: 40, height: 46 }} /> : null}
          <IconButton name={mode === 'code' ? 'checkmark-circle-outline' : 'arrow-up-circle'} label={mode === 'code' ? 'Проверить задачу по коду перед отправкой' : 'Отправить вопрос AI'} onPress={send} disabled={!canSend} color={t.accent} size={41} style={{ width: 46, height: 46 }} />
        </View>
        <Text style={{ color: t.muted, fontSize: 10, textAlign: 'right', paddingRight: 5 }}>{!ai.state.consent ? 'Сначала включи разрешение отправлять вопросы · ' : mode === 'code' ? 'Далее — проверка задачи · ' : ''}{draft.length} / {inputLimit}</Text>
      </>}
    </GlassSurface> : null}
    <Sheet visible={modelSheet} title="Модель AI" onClose={() => setModelSheet(false)}>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, marginBottom: 8 }}>FreeLLMAPI сам выбирает бесплатную модель и переключается, если одна исчерпала лимит. Можно задать стратегию или конкретную модель из доступных сейчас.</Text>
      {(['auto', 'auto:smart', 'auto:fast', 'auto:reliable', 'fusion'] as const).concat(models as never[]).map(id => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ selected: model === id }} onPress={() => { setModel(id); setModelSheet(false); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 }}><Icon name={model === id ? 'radio-button-on' : 'radio-button-off'} size={19} color={model === id ? t.accent : t.muted} /><View style={{ flex: 1 }}><Text style={{ color: t.text, fontSize: 14 }}>{modelLabel(id)}</Text>{STRATEGY_HELP[id] ? <Text style={{ color: t.muted, fontSize: 11 }}>{STRATEGY_HELP[id]}</Text> : null}</View></Pressable>)}
      {!models.length ? <Text style={{ color: t.muted, fontSize: 11, paddingTop: 6 }}>Список конкретных моделей появится, когда в панели FreeLLMAPI будут добавлены ключи провайдеров.</Text> : null}
    </Sheet>
    <Sheet visible={historySheet} title="История AI" onClose={() => setHistorySheet(false)}>
      {history?.items.length ? history.items.map(item => <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable accessibilityRole="button" onPress={() => openConversation(item)} style={({ pressed }) => ({ flex: 1, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 16, backgroundColor: item.id === conversationId ? t.accentSoft : pressed ? t.surface2 : 'transparent', gap: 4 })}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{item.title}</Text>
          <Text style={{ color: t.muted, fontSize: 11 }}>{formatListTime(item.updatedAt)} · {item.turns.length} {item.turns.length === 1 ? 'вопрос' : item.turns.length < 5 ? 'вопроса' : 'вопросов'}</Text>
        </Pressable>
        <IconButton name="trash-outline" label={`Удалить беседу ${item.title}`} color={t.danger} size={19} onPress={() => { history.remove(item.id); if (item.id === conversationId) clear(); }} />
      </View>) : <Text style={{ color: t.muted, fontSize: 13 }}>Пока нет сохранённых бесед.</Text>}
    </Sheet>
    <CodeApproval preview={approval?.preview || null} allowed={ready && ai.state.consent && !ai.state.pending} onCancel={() => setApproval(null)} onApprove={approveCode} />
  </KeyboardSafeView>;
}

export function AIQuickDialog({ api, visible, onClose }: { api: Api; visible: boolean; onClose: () => void }) {
  if (!visible) return null;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><GlassStage><SafeAreaView style={{ flex: 1 }}><AIScreen api={api} onBack={onClose} quick /></SafeAreaView></GlassStage></Modal>;
}
