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
import { PlatinaGem, openPlatinaShowcase } from '../platina/PlatinaMark';
import { formatListTime, useTheme } from '../theme';
import { aiModels, aiQuestion, aiStatus } from './client';
import { AIMediaPanel, type MediaMode } from './AIMedia';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { AIConversation, AI_MESSAGE_LIMIT, CODE_TASK_PREFIX, codePreviewCurrent, createCodeTaskPreview, type AICapabilityName, type AIState, type AIStatus, type AITurn, type CodeTaskPreview } from './conversation';
import { useTabInset } from '../tabInset';

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

export function AIScreen({ api, onBack, quick = false, history, name }: { api: Api; onBack: () => void; quick?: boolean; history?: AIHistoryStore; name?: string }) {
  const tabInset = useTabInset();
  const t = useTheme(), ai = useAI(api);
  const [conversationId, setConversationId] = useState(() => Crypto.randomUUID());
  const [historySheet, setHistorySheet] = useState(false);
  const restored = useRef(false);
  const [toolsSheet, setToolsSheet] = useState(false), [consentSheet, setConsentSheet] = useState(false), [focused, setFocused] = useState(false), [incognito, setIncognito] = useState(false);
  // Reopen the latest conversation once the encrypted history has loaded (not for the quick dialog).
  useEffect(() => {
    if (restored.current || !history?.loaded || !ai.conversation.current) return;
    restored.current = true;
    const latest = history.items[0];
    if (!quick && latest && !ai.conversation.current.getSnapshot().turns.length) { setConversationId(latest.id); ai.conversation.current.restore(latest.turns, latest.consent); }
  }, [history?.loaded, history?.items, quick, ai.conversation, ai.state]);
  useEffect(() => { if (history && !incognito && !ai.state.pending && ai.state.turns.length) history.save(conversationId, ai.state.turns, ai.state.consent); }, [ai.state, conversationId, history?.save, incognito]);
  const [draft, setDraft] = useState(''), [mode, setMode] = useState<'text' | 'code' | MediaMode>('text'), [taskError, setTaskError] = useState('');
  const [model, setModel] = useState('auto'), [models, setModels] = useState<string[]>([]), [modelSheet, setModelSheet] = useState(false), [photo, setPhoto] = useState<string | null>(null);
  const router = ai.status?.provider === 'freellmapi';
  // Without Platina: fast text answers only. Everything else is shown locked and explains why.
  const full = ai.status?.platina !== false;
  const [platinaSheet, setPlatinaSheet] = useState('');
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
  const askOptions = () => router && full ? { ...(model !== 'auto' ? { model } : {}), ...(photo && mode === 'text' ? { image: photo } : {}) } : undefined;
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
  const modes = ([{ id: 'text', label: 'Вопрос', icon: 'chatbubble-ellipses-outline' }, { id: 'code', label: 'Код', icon: 'code-slash-outline' }, ...(router ? [{ id: 'image', label: 'Картинка', icon: 'image-outline' }, { id: 'video', label: 'Видео', icon: 'videocam-outline' }, { id: 'speech', label: 'Озвучка', icon: 'volume-high-outline' }, { id: 'transcribe', label: 'Аудио → текст', icon: 'mic-outline' }] : [])] as { id: 'text' | 'code' | MediaMode; label: string; icon: IconName }[]);
  const modeItem = modes.find(item => item.id === mode);
  const hour = new Date().getHours();
  const greeting = `${hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'}${name ? `, ${name}` : ''}`;
  const expanded = focused || !!draft || !!photo;
  // First question of a conversation: ask once, in a sheet, instead of a permanent card on screen.
  const submit = () => { if (!draft.trim() || !ready || ai.state.pending) return; if (!ai.state.consent) { setConsentSheet(true); return; } send(); };
  const empty = !ai.state.turns.length && !media;
  const roundButton = (icon: IconName, label: string, onPress: () => void, active = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: active ? t.accent : t.glassBorder, opacity: pressed ? .7 : 1 })}><Icon name={icon} size={21} color={active ? t.accent : t.text} /></Pressable>;
  const sendButton = <Pressable accessibilityRole="button" accessibilityLabel={mode === 'code' ? 'Проверить задачу по коду перед отправкой' : 'Отправить вопрос AI'} accessibilityState={{ disabled: !draft.trim() || !ready }} disabled={!draft.trim() || !ready} onPress={submit} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: draft.trim() && ready ? t.text : t.surface2, opacity: pressed ? .75 : 1 })}><Icon name={mode === 'code' ? 'checkmark' : 'arrow-up'} size={21} color={draft.trim() && ready ? (t.dark ? '#111' : '#FFF') : t.muted} /></Pressable>;
  const plusButton = <Pressable accessibilityRole="button" accessibilityLabel="Режимы AI и вложения" disabled={ai.state.pending} onPress={() => setToolsSheet(true)} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: pressed ? .7 : 1 })}><Icon name="add" size={24} color={t.text} /></Pressable>;
  const modelPill = router && !media ? <Pressable accessibilityRole="button" accessibilityLabel="Выбрать модель AI" onPress={() => full ? setModelSheet(true) : setPlatinaSheet('Выбор модели')} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 42, paddingHorizontal: 14, borderRadius: 21, backgroundColor: t.surface2, opacity: pressed ? .7 : 1 })}><Text style={{ color: t.text, fontSize: 14 }}>{full ? modelLabel(model) : 'Быстрые ответы'}</Text>{mode !== 'text' && modeItem ? <Text style={{ color: t.muted, fontSize: 14 }}>{modeItem.label}</Text> : null}</Pressable> : mode !== 'text' && modeItem ? <View style={{ height: 42, paddingHorizontal: 14, borderRadius: 21, backgroundColor: t.surface2, justifyContent: 'center' }}><Text style={{ color: t.text, fontSize: 14 }}>{modeItem.label}</Text></View> : null;
  return <KeyboardSafeView bottomInset={quick ? 0 : tabInset} style={{ flex: 1, backgroundColor: 'transparent' }}>
    {/* Top: history on the left, private mode on the right (as in modern AI chat apps). */}
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, gap: 10 }}>
      {quick ? roundButton('close', 'Закрыть быстрый вопрос AI', onBack) : history ? roundButton('menu-outline', 'История AI-бесед', () => setHistorySheet(true)) : null}
      <View style={{ flex: 1 }} />
      {ai.state.turns.length ? roundButton('create-outline', 'Начать новую AI-беседу', clear) : null}
      {history ? roundButton(incognito ? 'eye-off' : 'eye-off-outline', incognito ? 'Приватная беседа включена: не сохраняется' : 'Приватная беседа: не сохранять в историю', () => setIncognito(value => !value), incognito) : null}
    </View>
    <ScrollView keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} ref={list} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: 20, width: '100%', maxWidth: 760, alignSelf: 'center', gap: 13, flexGrow: 1 }} onContentSizeChange={() => { if (ai.state.pending || last?.status === 'complete') list.current?.scrollToEnd({ animated: true }); }}>
      {ai.checking ? <View style={{ flex: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={t.accent} size="small" /><Text style={help}>Проверяем доступность AI…</Text></View>
        : ai.statusError ? <View style={{ flex: 1, justifyContent: 'center' }}><Notice text={ai.statusError} error onRetry={ai.refresh} /></View>
        : !ready && empty ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20 }}><Icon name="sparkles-outline" color={t.muted} size={34} /><Text style={{ color: t.text, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>AI пока не подключён на этом сервере</Text><Text style={{ ...help, textAlign: 'center' }}>Когда администратор подключит сервис, здесь можно будет задать вопрос.</Text><Button secondary label="Проверить снова" icon="refresh-outline" onPress={ai.refresh} /></View>
        : empty ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingBottom: 30 }}>
            <Icon name="sparkles" size={40} color={t.accent} />
            <Text style={{ color: t.text, fontSize: 28, lineHeight: 34, fontWeight: '500', letterSpacing: -0.6, textAlign: 'center', opacity: .92 }}>{greeting}</Text>
            {incognito ? <Text style={{ ...help, textAlign: 'center' }}>Приватная беседа: она не сохранится в истории.</Text> : null}
          </View> : null}
      {media && ready ? <AIMediaPanel api={api} mode={mode as MediaMode} consent={ai.state.consent} /> : null}
      {ai.state.turns.map(turn => <AITurnView key={turn.id} turn={turn} retryable={turn.id === last?.id} canRetry={ready && ai.state.consent && !ai.state.pending} onRetry={() => void ai.conversation.current?.retry()} />)}
      {ai.state.error && ai.state.error !== last?.error ? <Notice text={ai.state.error} error /> : null}
      {taskError ? <Notice text={taskError} error /> : null}
    </ScrollView>
    {media ? <View style={{ paddingHorizontal: 16, paddingBottom: 12, flexDirection: 'row', gap: 8 }}>{plusButton}{modelPill}</View> : <View style={{ marginHorizontal: 14, marginBottom: 12, marginTop: 3, borderRadius: 30, backgroundColor: t.dark ? 'rgba(46,46,48,0.96)' : 'rgba(255,255,255,0.96)', borderWidth: 1, borderColor: t.glassBorder, padding: 8, gap: 6 }}>
      {photo && mode === 'text' ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 6, paddingTop: 4 }}><Image source={{ uri: photo }} style={{ width: 44, height: 44, borderRadius: 10 }} /><Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>Фото к вопросу</Text><IconButton name="close" label="Убрать фото" size={18} color={t.muted} onPress={() => setPhoto(null)} /></View> : null}
      {ai.state.pending ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 4 }}><ActivityIndicator color={t.accent} /><Text style={{ flex: 1, color: t.muted, fontSize: 13 }}>AI готовит ответ…</Text><Pressable accessibilityRole="button" accessibilityLabel="Отменить ожидание" onPress={() => ai.conversation.current?.cancel()} style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.text }}><Icon name="stop" size={18} color={t.dark ? '#111' : '#FFF'} /></Pressable></View>
        : expanded ? <>
          <ComposerInput accessibilityLabel={mode === 'code' ? 'Задача по коду для AI' : 'Вопрос AI'} value={draft} onChangeText={setDraft} onKeyPress={e => { if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !(e.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) { e.preventDefault(); submit(); } }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} autoFocus={focused} placeholder={mode === 'code' ? 'Опиши задачу по коду' : 'Спроси что угодно'} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} multiline maxLength={inputLimit} style={{ minHeight: 44, maxHeight: 160, paddingHorizontal: 10, paddingTop: 10, color: t.text, fontSize: 17, lineHeight: 23 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{plusButton}{modelPill}<View style={{ flex: 1 }} />{router && full && mode === 'text' && ai.status?.capabilities.vision.enabled ? <Pressable accessibilityRole="button" accessibilityLabel="Прикрепить фото к вопросу" onPress={() => void attachPhoto()} style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2 }}><Icon name="image-outline" size={20} color={t.text} /></Pressable> : null}{sendButton}</View>
        </> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{plusButton}<Pressable accessibilityRole="button" accessibilityLabel={mode === 'code' ? 'Написать задачу по коду' : 'Написать вопрос AI'} onPress={() => setFocused(true)} style={{ flex: 1, height: 42, justifyContent: 'center', paddingHorizontal: 6 }}><Text numberOfLines={1} style={{ color: t.muted, fontSize: 17 }}>{mode === 'code' ? 'Опиши задачу по коду' : 'Спроси что угодно'}</Text></Pressable>{sendButton}</View>}
    </View>}
    <Sheet visible={toolsSheet} title="Что сделать" onClose={() => setToolsSheet(false)}>
      <View style={{ gap: 4 }}>
        {modes.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected: mode === item.id }} onPress={() => { setToolsSheet(false); if (!full && item.id !== 'text') { setTimeout(() => setPlatinaSheet(item.label), 300); return; } setMode(item.id); setTaskError(''); }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 14, backgroundColor: mode === item.id ? t.accentSoft : pressed ? t.surface2 : 'transparent' })}><Icon name={item.icon} size={21} color={mode === item.id ? t.accent : t.text} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{item.label}</Text>{!full && item.id !== 'text' ? <Icon name="lock-closed" size={14} color={t.muted} /> : mode === item.id ? <Icon name="checkmark" size={18} color={t.accent} /> : null}</Pressable>)}
        {router && full && mode === 'text' && ai.status?.capabilities.vision.enabled ? <Pressable accessibilityRole="button" onPress={() => { setToolsSheet(false); void attachPhoto(); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 6 }}><Icon name="image-outline" size={21} color={t.text} /><Text style={{ color: t.text, fontSize: 15 }}>Фото к вопросу</Text></Pressable> : null}
        {!router ? <View style={{ paddingTop: 8 }}><AIUnavailableTools status={ai.status} checking={ai.checking} /></View> : null}
      </View>
    </Sheet>
    <Sheet visible={consentSheet} title="Отправить вопрос AI?" onClose={() => setConsentSheet(false)}>
      <View style={{ gap: 12 }}>
        <Text style={help}>Вопросы и история этой беседы передаются через твой сервер {ai.status?.provider === 'freellmapi' ? 'в сервис FreeLLMAPI и бесплатному поставщику модели, которого он выберет' : 'в OpenRouter и поставщику модели'}. В AI попадает только текст, который ты пишешь здесь. Разрешение действует только для этой беседы.</Text>
        <Text style={help}>{history ? (incognito ? 'Это приватная беседа: на устройстве она не сохранится.' : 'История бесед хранится зашифрованной только на этом устройстве.') : 'В быстром вопросе история очищается при закрытии окна.'}</Text>
        {ai.status?.provider !== 'freellmapi' ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://openrouter.ai/privacy')} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}><Text style={{ color: t.accent, fontSize: 12 }}>Конфиденциальность OpenRouter</Text></Pressable> : null}
        <Button label="Разрешить и отправить" icon="arrow-up-outline" onPress={() => { ai.conversation.current?.setConsent(true); setConsentSheet(false); setTimeout(send, 0); }} />
        <Button secondary label="Отмена" onPress={() => setConsentSheet(false)} />
      </View>
    </Sheet>
    <Sheet visible={!!platinaSheet} title={platinaSheet ? `${platinaSheet} — с Platina` : 'Platina'} onClose={() => setPlatinaSheet('')}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><PlatinaGem size={18} /><Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: '600' }}>Доступно только с подпиской Инвиз Platina</Text></View>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>Без Platina AI отвечает на текстовые вопросы быстрой моделью. С Platina — выбор моделей, код, вопросы по фото, картинки, видео, озвучка и расшифровка аудио.</Text>
        <Button label="Подробнее о Platina" icon="diamond-outline" onPress={() => { setPlatinaSheet(''); setTimeout(() => openPlatinaShowcase(), 300); }} />
      </View>
    </Sheet>
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
