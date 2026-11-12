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
import { aiDocument, aiImage, aiModels, aiQuestion, aiSpeech, aiStatus, aiTranscribe, aiVideo, type AIDocument } from './client';
import { AudioResult, VideoResult, share, type MediaMode } from './AIMedia';
import { deleteAIMedia, holdAIMedia, mediaUris, missingAIMedia, pruneAIMedia, resolveAIMediaUri, writeAIMedia } from './mediaCache';
import { detectIntent, speechText } from './intent';
import { fromByteArray } from 'base64-js';
import { ModelMenu } from './ModelMenu';
import { MAX_PICTURES, pickAudio, pickDocumentsOrMedia, pickPictures, type AIPicture } from './attach';
import { AIConversation, parseAIReply, type AITaskKind, type AITaskWork, AI_MESSAGE_LIMIT, CODE_TASK_PREFIX, codePreviewCurrent, createCodeTaskPreview, type AICapabilityName, type AIState, type AIStatus, type AITurn, type CodeTaskPreview } from './conversation';
import { useTabInset } from '../tabInset';

const emptyState = (): AIState => ({ consent: false, turns: [], pending: false, error: '' });

function useAI(api: Api) {
  const [state, setState] = useState<AIState>(emptyState), [status, setStatus] = useState<AIStatus | null>(null);
  const [statusError, setStatusError] = useState(''), [checking, setChecking] = useState(true), [refreshKey, setRefreshKey] = useState(0);
  const conversation = useRef<AIConversation | null>(null);
  useEffect(() => {
    // A picture/video/speech file finished for a turn that is gone (cancelled, consent revoked, screen closed) is deleted at once.
    const owner = new AIConversation((messages, signal, options) => aiQuestion(api, messages, signal, options), { discardMedia: media => void deleteAIMedia([media.uri]) });
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

// What the AI is doing right now, step by step (like the «думает» line in Claude). Only real stages are
// shown: the request leaves for the server, the chosen model works on it; the timer is honest elapsed time.
function AIProgress({ turn, router }: { turn: AITurn; router: boolean }) {
  const t = useTheme();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - (turn.startedAt || now)) / 1000));
  const model = modelLabel(turn.options?.model || 'auto');
  const working = turn.stage || (turn.kind === 'image' ? 'Рисую картинку' : turn.kind === 'video' ? 'Создаю видео — это может занять до 5 минут' : turn.kind === 'speech' ? 'Озвучиваю текст' : turn.kind === 'transcribe' ? 'Расшифровываю аудио' : router ? (turn.options?.model ? `Модель «${model}» пишет ответ` : 'Подбираю свободную модель и пишу ответ') : 'Бесплатная модель пишет ответ');
  const steps: { text: string; done: boolean }[] = [
    { text: turn.options?.image ? 'Запрос и фото отправлены на сервер' : 'Запрос отправлен на сервер', done: seconds >= 1 },
    { text: working, done: false },
  ];
  return <View style={{ gap: 8, paddingHorizontal: 6, paddingVertical: 4 }}>
    {steps.map((step, index) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      {step.done ? <Icon name="checkmark-circle" size={16} color={t.accent} /> : <ActivityIndicator size="small" color={t.accent} />}
      <Text style={{ flex: 1, color: step.done ? t.muted : t.text, fontSize: 13 }}>{step.text}{!step.done && index === steps.length - 1 ? ` · ${seconds} с` : ''}</Text>
    </View>)}
    {seconds >= 12 && turn.kind !== 'video' ? <Text style={{ color: t.muted, fontSize: 11, lineHeight: 16, paddingLeft: 25 }}>{router ? 'Бесплатные модели бывают заняты — сервер может переключиться на другую. Ждём до 2 минут.' : 'Бесплатные модели иногда отвечают медленно. Ждём до 2 минут.'}</Text> : null}
  </View>;
}

function AITurnView({ turn, retryable, canRetry, onRetry, router = false }: { turn: AITurn; retryable: boolean; canRetry: boolean; onRetry: () => void; router?: boolean }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const code = turn.question.startsWith(CODE_TASK_PREFIX);
  const [details, setDetails] = useState(false);
  // The history keeps the file's name; the cache folder itself can move between app updates (iOS).
  const mediaUri = turn.media ? resolveAIMediaUri(turn.media.uri) : '';
  // A made picture/video/speech whose cache file is gone (evicted, wiped or dropped): say so instead of the orphaned caption.
  const mediaGone = !!turn.answer && !turn.media && (turn.kind === 'image' || turn.kind === 'video' || turn.kind === 'speech');
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (!turn.answer) return;
    await Clipboard.setStringAsync(turn.answer.text);
    setCopied(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return <View style={{ gap: 10, marginBottom: 18 }}>
    <View style={{ alignSelf: 'flex-end', maxWidth: '92%', backgroundColor: t.bubble, padding: 14, borderRadius: 22, borderBottomRightRadius: 7, borderWidth: 1, borderColor: t.glassBorder, gap: 6 }}>{code ? <Text style={{ color: t.accent, fontSize: 10, fontWeight: '700' }}>Задача по коду</Text> : null}<Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>{code ? turn.question.slice(CODE_TASK_PREFIX.length) : turn.question}</Text></View>
    {turn.answer ? <GlassSurface radius={23} shadow={false} contentStyle={{ padding: 16, gap: 11 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Как получен ответ" onPress={() => setDetails(value => !value)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start' }}><Icon name="sparkles-outline" size={17} color={t.accent} /><Text style={{ color: t.accent, fontWeight: '700', fontSize: 12 }}>{typeof turn.ms === 'number' ? `Ответ за ${Math.max(1, Math.round(turn.ms / 1000))} с` : 'AI'}</Text><Icon name={details ? 'chevron-up' : 'chevron-down'} size={13} color={t.accent} /></Pressable>
      {details ? <View style={{ gap: 4, paddingLeft: 24 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>Выбор: {modelLabel(turn.options?.model || 'auto')}</Text>
        <Text selectable style={{ color: t.muted, fontSize: 12 }}>Ответила модель: {turn.answer.model}</Text>
        {turn.answer.routedVia ? <Text selectable style={{ color: t.muted, fontSize: 12 }}>Через: {turn.answer.routedVia}</Text> : null}
      </View> : null}
      {turn.media?.mimeType.startsWith('image/') ? <Pressable accessibilityRole="button" accessibilityLabel="Сохранить или отправить картинку" onPress={() => void share(mediaUri, turn.media!.mimeType).catch(() => {})}><Image source={{ uri: mediaUri }} style={{ width: '100%', aspectRatio: 1, borderRadius: 16, backgroundColor: t.surface2 }} resizeMode="cover" /></Pressable>
        : turn.media?.mimeType === 'video/mp4' ? <VideoResult uri={mediaUri} onShare={() => void share(mediaUri, turn.media!.mimeType).catch(() => {})} />
        : turn.media?.mimeType.startsWith('audio/') ? <AudioResult uri={mediaUri} onShare={() => void share(mediaUri, turn.media!.mimeType).catch(() => {})} /> : null}
      {mediaGone ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name="trash-outline" size={15} color={t.muted} /><Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Файл удалён из кэша</Text></View> : null}
      {mediaGone && turn.kind !== 'speech' ? null : <Text selectable style={{ color: turn.media || mediaGone ? t.muted : t.text, fontSize: turn.media || mediaGone ? 13 : 15, lineHeight: turn.media || mediaGone ? 19 : 23 }}>{turn.answer.text}</Text>}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }} /><Pressable accessibilityRole="button" accessibilityLabel="Скопировать ответ AI" onPress={() => void copy()} style={{ padding: 8 }}><Icon name={copied ? 'checkmark' : 'copy-outline'} size={17} color={t.accent} /></Pressable></View>
    </GlassSurface> : turn.status === 'pending' ? <AIProgress turn={turn} router={router} /> : <View style={{ paddingHorizontal: 8, gap: 8 }}>
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

const STRATEGIES: { id: string; help: string }[] = [
  { id: 'auto:smart', help: 'Для сложных вопросов и кода. Отвечает дольше' },
  { id: 'auto', help: 'Сама выбирает свободную модель' },
  { id: 'auto:fast', help: 'Быстрые ответы на простые вопросы' },
  { id: 'auto:reliable', help: 'Модели, которые реже бывают заняты' },
  { id: 'fusion', help: 'Отвечают несколько моделей, выбирается лучший ответ' },
];
const modelLabel = (id: string) => ({ auto: 'Авто', 'auto:smart': 'Умная', 'auto:fast': 'Быстрая', 'auto:reliable': 'Надёжная', 'auto:balanced': 'Сбалансированная', fusion: 'Консилиум' } as Record<string, string>)[id] || id.split('/').pop() || id;

export function AIScreen({ api, onBack, quick = false, history, name }: { api: Api; onBack: () => void; quick?: boolean; history?: AIHistoryStore; name?: string }) {
  const tabInset = useTabInset();
  const t = useTheme(), ai = useAI(api);
  // Quick-dialog conversations are told apart by their id prefix (it ends up in the cache file names too).
  const newConversationId = () => `${quick ? 'quick-' : ''}${Crypto.randomUUID()}`;
  const [conversationId, setConversationId] = useState(newConversationId);
  const [historySheet, setHistorySheet] = useState(false);
  const restored = useRef(false);
  const [toolsSheet, setToolsSheet] = useState(false), [consentSheet, setConsentSheet] = useState(false), [focused, setFocused] = useState(false), [incognito, setIncognito] = useState(false);
  // Reopen the latest conversation once the encrypted history has loaded (not for the quick dialog).
  useEffect(() => {
    if (restored.current || !history?.loaded || !ai.conversation.current) return;
    restored.current = true;
    const latest = history.items[0];
    if (!quick && latest && !ai.conversation.current.getSnapshot().turns.length) { setConversationId(latest.id); reopen(ai.conversation.current, latest.turns, latest.consent); }
  }, [history?.loaded, history?.items, quick, ai.conversation, ai.state]);
  // Turns asked while «Приватная беседа» is on are marked private and never reach the history — even
  // when the mode is switched off later (storedTurns drops them).
  useEffect(() => { ai.conversation.current?.setPrivate(incognito); }, [incognito, api, ai.conversation]);
  useEffect(() => { if (history && !incognito && !ai.state.pending && ai.state.turns.length) history.save(conversationId, ai.state.turns, ai.state.consent); }, [ai.state, conversationId, history?.save, incognito]);
  // The files on this screen are held while it is mounted: a prune from the other AI screen (quick dialog
  // over the main one, or the other way round) never removes them. The hold is set before the prune below runs.
  useEffect(() => holdAIMedia(mediaUris(ai.state.turns)), [ai.state.turns]);
  // Generated pictures/videos/speech live in the cache: files no stored or open conversation shows any
  // more are removed, and the whole set is capped (see mediaCache.ts). Not for the quick dialog: it has
  // no history and must not touch the files of stored conversations.
  useEffect(() => {
    if (!history?.loaded || ai.state.pending) return;
    const open = mediaUris(ai.state.turns);
    void pruneAIMedia([...history.items.flatMap(item => mediaUris(item.turns)), ...open], open).catch(() => {});
  }, [history?.loaded, history?.items, ai.state.pending, ai.state.turns, conversationId]);
  // Once the screen closes nothing refers to the files of private turns — nor to any file of the quick dialog (no history).
  const turnsRef = useRef(ai.state.turns), persistent = !!history; turnsRef.current = ai.state.turns;
  useEffect(() => () => { void deleteAIMedia(mediaUris(turnsRef.current.filter(turn => turn.private || !persistent))); }, [persistent]);
  // One chat for everything: the request itself decides (see intent.ts) — no separate modes to pick.
  const [draft, setDraft] = useState(''), [taskError, setTaskError] = useState('');
  const mode = 'text' as 'text' | 'code' | MediaMode;
  const [model, setModel] = useState('auto'), [models, setModels] = useState<string[]>([]), [pictures, setPictures] = useState<AIPicture[]>([]);
  // Documents stay attached to the whole conversation: every question is answered with them.
  const [documents, setDocuments] = useState<AIDocument[]>([]), [reading, setReading] = useState(0);
  const photo = pictures[0]?.data || null;
  const setPhoto = (_: null) => setPictures([]);
  const router = ai.status?.provider === 'freellmapi';
  // Without Platina: fast text answers only. Everything else is shown locked and explains why.
  const full = ai.status?.platina !== false;
  const [platinaSheet, setPlatinaSheet] = useState('');
  const media = false;
  useEffect(() => { if (!router || !ai.status?.capabilities.models.enabled) return; const request = new AbortController(); aiModels(api, request.signal).then(result => setModels(result.models)).catch(() => {}); return () => request.abort(); }, [api, router, ai.status]);
  const attachPictures = async () => {
    try { const added = await pickPictures(MAX_PICTURES - pictures.length); if (added.length) { setPictures(list => [...list, ...added].slice(0, MAX_PICTURES)); setFocused(true); } setTaskError(''); }
    catch (error) { setTaskError(error instanceof Error ? error.message : 'Не удалось подготовить фото.'); }
  };
  const attachDocuments = async () => {
    try {
      const { files, pictures: media } = await pickDocumentsOrMedia(MAX_PICTURES - pictures.length);
      // A photo or video chosen as a file is attached as cleaned pictures, like the «Фото и видео» button does.
      if (media.length) { setPictures(list => [...list, ...media].slice(0, MAX_PICTURES)); setFocused(true); setTaskError(''); }
      if (!files.length) return;
      setTaskError(''); setReading(value => value + files.length);
      for (const file of files) {
        try { const doc = await aiDocument(api, file.name, file.base64); setDocuments(list => [...list.filter(item => item.name !== doc.name), doc].slice(-5)); setFocused(true); }
        catch (error) { setTaskError(`«${file.name}»: ${error instanceof Error ? error.message : 'не удалось прочитать.'}`); }
        finally { setReading(value => value - 1); }
      }
    } catch (error) { setTaskError(error instanceof Error ? error.message : 'Не удалось открыть документ.'); }
  };
  // What to do once the «+» sheet has fully closed (a picker cannot open over a closing sheet on iOS).
  const afterTools = useRef<(() => void) | null>(null);
  const afterConsent = useRef<(() => void) | null>(null);
  const [approval, setApproval] = useState<{ preview: CodeTaskPreview; owner: AIConversation } | null>(null);
  const list = useRef<ScrollView>(null);
  const ready = ai.status?.configured === true && ai.status.capabilities[mode].enabled, last = ai.state.turns.at(-1);
  // Photos (video frames) and documents go with either provider when the server allows them; model choice needs FreeLLMAPI.
  const vision = !!ai.status?.capabilities.vision?.enabled;
  const docs = !!ai.status?.capabilities.documents?.enabled;
  const askOptions = () => {
    if (!full) return undefined;
    const options = { ...(router && model !== 'auto' ? { model } : {}), ...(vision && pictures.length ? { image: pictures.map(item => item.data) } : {}), ...(docs && documents.length ? { documents: documents.map(doc => ({ name: doc.name, text: doc.text })) } : {}) };
    return Object.keys(options).length ? options : undefined;
  };
  const inputLimit = mode === 'code' ? AI_MESSAGE_LIMIT - CODE_TASK_PREFIX.length : AI_MESSAGE_LIMIT;
  const canSend = ready && ai.state.consent && !ai.state.pending && !!draft.trim();
  const help = { color: t.muted, fontSize: 12, lineHeight: 18 };
  useEffect(() => { setDraft(''); setApproval(null); setTaskError(''); }, [api]);
  function send() {
    if (!ready || !ai.conversation.current) return;
    const owner = ai.conversation.current;
    if (mode === 'code') {
      try { setApproval({ owner, preview: createCodeTaskPreview(owner.getSnapshot().turns, draft) }); setTaskError(''); }
      catch (error) { setTaskError(error instanceof Error ? error.message : 'Не удалось подготовить задачу.'); }
      return;
    }
    const intent = detectIntent(draft, !!photo);
    if (intent !== 'text') {
      const label = intent === 'image' ? 'Картинки' : intent === 'video' ? 'Видео' : 'Озвучка';
      if (!full) { setPlatinaSheet(label); return; }
      if (!router || !ai.status?.capabilities[intent].enabled) { setTaskError(`${label} пока не подключены на сервере — отвечу текстом.`); void owner.ask(draft, askOptions()); if (owner.getSnapshot().pending) { setDraft(''); setPhoto(null); } return; }
      const question = draft.trim(), image = photo;
      const work: AITaskWork = intent === 'image' ? async (signal, stage) => {
        let prompt = question;
        if (image) {
          // The provider draws from text, so the photo is first described (vision) together with the request.
          stage('Смотрю на твоё фото');
          const reply = parseAIReply(await aiQuestion(api, [{ role: 'user', content: `Опиши это изображение для генератора картинок: что на нём, цвета, композиция, стиль. Учти просьбу пользователя и выдай один итоговый промпт на английском до 900 символов, без пояснений.\n\nПросьба: ${question}` }], signal, { image }));
          prompt = reply.text.slice(0, 3900);
        }
        stage('Рисую картинку');
        const result = await aiImage(api, prompt, signal);
        const uri = await writeAIMedia(conversationId, result.base64, result.mimeType);
        return { text: image ? 'Новая картинка по мотивам твоего фото (провайдер рисует заново по описанию, само фото не меняется). Нажми на картинку, чтобы сохранить или отправить.' : 'Готово. Нажми на картинку, чтобы сохранить или отправить.', model: result.routedVia || 'генерация картинок', routedVia: result.routedVia, media: { uri, mimeType: result.mimeType } };
      } : intent === 'video' ? async signal => {
        const bytes = await aiVideo(api, question, 5, signal);
        const uri = await writeAIMedia(conversationId, fromByteArray(new Uint8Array(bytes)), 'video/mp4');
        return { text: 'Видео готово.', model: 'генерация видео', media: { uri, mimeType: 'video/mp4' } };
      } : async signal => {
        const spoken = speechText(question);
        if (!spoken) throw new Error('Напиши после «озвучь», что именно сказать.');
        const result = await aiSpeech(api, spoken, 'nova', signal);
        const uri = await writeAIMedia(conversationId, result.base64, result.mimeType);
        return { text: spoken, model: 'озвучка', media: { uri, mimeType: result.mimeType } };
      };
      void owner.askTask(question, intent, work);
      if (owner.getSnapshot().pending) { setDraft(''); setPhoto(null); setTaskError(''); }
      return;
    }
    void owner.ask(draft, askOptions());
    if (owner.getSnapshot().pending) { setDraft(''); setPhoto(null); }
  }
  async function transcribeFile() {
    const owner = ai.conversation.current;
    if (!owner || !ready) return;
    // Read consent from the live conversation, not from this render's snapshot: the continuation stored in
    // afterConsent is the closure of the render where consent was still false.
    if (!owner.getSnapshot().consent) { afterConsent.current = () => void transcribeFile(); setConsentSheet(true); return; }
    let file: Awaited<ReturnType<typeof pickAudio>> = null;
    try { file = await pickAudio(); } catch (error) { setTaskError(error instanceof Error ? error.message : 'Не удалось открыть аудио.'); return; }
    if (!file) return;
    const audio = file;
    void owner.askTask(`Расшифруй аудио «${audio.name}»`, 'transcribe' as AITaskKind, async signal => ({ text: await aiTranscribe(api, audio.base64, signal), model: 'расшифровка аудио' }));
  }
  function approveCode() {
    const owner = ai.conversation.current;
    if (!approval || !owner || !ready || !ai.state.consent || approval.owner !== owner || !codePreviewCurrent(owner.getSnapshot().turns, approval.preview)) {
      setApproval(null); setTaskError('Беседа изменилась. Проверь задачу ещё раз перед отправкой.'); return;
    }
    void owner.ask(approval.preview.prompt, askOptions());
    if (owner.getSnapshot().pending) { setDraft(''); setApproval(null); setTaskError(''); }
  }
  // Reopens a stored conversation; pictures whose cache files are gone are forgotten instead of shown broken.
  function reopen(owner: AIConversation, turns: AITurn[], consent: boolean) {
    owner.restore(turns, consent);
    void missingAIMedia(owner.getSnapshot().turns).then(missing => owner.dropMedia(missing)).catch(() => {});
  }
  function clear() {
    // Files nothing will show again: private turns, and every turn of a conversation without history.
    const turns = ai.conversation.current?.getSnapshot().turns || [];
    void deleteAIMedia(mediaUris(turns.filter(turn => turn.private || !history)));
    setDocuments([]); setPictures([]); ai.conversation.current?.clear(); setConversationId(newConversationId()); setDraft(''); setApproval(null); setTaskError('');
  }
  function openConversation(item: AIStoredConversation) { if (ai.conversation.current) reopen(ai.conversation.current, item.turns, item.consent); setConversationId(item.id); setDraft(''); setApproval(null); setTaskError(''); setHistorySheet(false); }
  const modes = ([{ id: 'text', label: 'Вопрос', icon: 'chatbubble-ellipses-outline' }, { id: 'code', label: 'Код', icon: 'code-slash-outline' }, ...(router ? [{ id: 'image', label: 'Картинка', icon: 'image-outline' }, { id: 'video', label: 'Видео', icon: 'videocam-outline' }, { id: 'speech', label: 'Озвучка', icon: 'volume-high-outline' }, { id: 'transcribe', label: 'Аудио → текст', icon: 'mic-outline' }] : [])] as { id: 'text' | 'code' | MediaMode; label: string; icon: IconName }[]);
  const modeItem = modes.find(item => item.id === mode);
  const hour = new Date().getHours();
  const greeting = `${hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'}${name ? `, ${name}` : ''}`;
  const expanded = focused || !!draft || pictures.length > 0 || documents.length > 0 || reading > 0;
  // First question of a conversation: ask once, in a sheet, instead of a permanent card on screen.
  const submit = () => { if (!draft.trim() || !ready || ai.state.pending) return; if (!ai.state.consent) { afterConsent.current = send; setConsentSheet(true); return; } send(); };
  const empty = !ai.state.turns.length && !media;
  const roundButton = (icon: IconName, label: string, onPress: () => void, active = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: active ? t.accent : t.glassBorder, opacity: pressed ? .7 : 1 })}><Icon name={icon} size={21} color={active ? t.accent : t.text} /></Pressable>;
  const sendButton = <Pressable accessibilityRole="button" accessibilityLabel={mode === 'code' ? 'Проверить задачу по коду перед отправкой' : 'Отправить вопрос AI'} accessibilityState={{ disabled: !draft.trim() || !ready }} disabled={!draft.trim() || !ready} onPress={submit} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: draft.trim() && ready ? t.text : t.surface2, opacity: pressed ? .75 : 1 })}><Icon name={mode === 'code' ? 'checkmark' : 'arrow-up'} size={21} color={draft.trim() && ready ? (t.dark ? '#111' : '#FFF') : t.muted} /></Pressable>;
  const plusButton = <Pressable accessibilityRole="button" accessibilityLabel="Режимы AI и вложения" disabled={ai.state.pending} onPress={() => setToolsSheet(true)} style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2, opacity: pressed ? .7 : 1 })}><Icon name="add" size={24} color={t.text} /></Pressable>;
  // Model choice like in the Claude app. Without the FreeLLMAPI router the server has one free model
  // («Авто»); without Platina only fast answers — other entries are shown locked.
  const modeChip = mode !== 'text' && modeItem ? <View style={{ height: 42, paddingHorizontal: 14, borderRadius: 21, backgroundColor: t.surface2, justifyContent: 'center' }}><Text style={{ color: t.text, fontSize: 14 }}>{modeItem.label}</Text></View> : null;
  const modelPill = <>{!media && ready ? <ModelMenu value={router && full ? model : 'auto'}
    entries={router ? STRATEGIES.map(item => ({ id: item.id, label: modelLabel(item.id), help: item.help })) : [{ id: 'auto', label: 'Авто', help: 'Бесплатная модель, которую подбирает сервер' }]}
    more={router ? models.filter(id => !STRATEGIES.some(item => item.id === id)).map(id => ({ id, label: modelLabel(id), help: id.includes('/') ? id.split('/')[0] : undefined })) : []}
    locked={router && !full} note={!router ? 'Выбор моделей появится, когда на сервере подключат FreeLLMAPI.' : !full ? 'Выбор модели — с Инвиз Platina.' : undefined}
    onChange={setModel} onLocked={() => setPlatinaSheet('Выбор модели')} /> : null}{modeChip}</>;
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
      {ai.state.turns.map(turn => <AITurnView key={turn.id} turn={turn} retryable={turn.id === last?.id} canRetry={ready && ai.state.consent && !ai.state.pending} onRetry={() => void ai.conversation.current?.retry()} router={router} />)}
      {ai.state.error && ai.state.error !== last?.error ? <Notice text={ai.state.error} error /> : null}
      {taskError ? <Notice text={taskError} error /> : null}
    </ScrollView>
    {media ? <View style={{ paddingHorizontal: 16, paddingBottom: 12, flexDirection: 'row', gap: 8 }}>{plusButton}{modelPill}</View> : <View style={{ marginHorizontal: 14, marginBottom: 12, marginTop: 3, borderRadius: 30, backgroundColor: t.dark ? 'rgba(46,46,48,0.96)' : 'rgba(255,255,255,0.96)', borderWidth: 1, borderColor: t.glassBorder, padding: 8, gap: 6 }}>
      {pictures.length || documents.length || reading ? <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 4, paddingTop: 4, alignItems: 'center' }}>
        {pictures.map(item => <View key={item.id} style={{ width: 54, height: 54 }}>
          <Image source={{ uri: item.uri }} style={{ width: 54, height: 54, borderRadius: 12, backgroundColor: t.surface2 }} />
          {item.video ? <View style={{ position: 'absolute', left: 4, bottom: 4, borderRadius: 6, paddingHorizontal: 3, backgroundColor: 'rgba(0,0,0,.55)' }}><Icon name="videocam" size={11} color="#FFF" /></View> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Убрать" hitSlop={8} onPress={() => setPictures(list => list.filter(other => other.id !== item.id))} style={{ position: 'absolute', top: -5, right: -5, width: 20, height: 20, borderRadius: 10, backgroundColor: t.text, alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={13} color={t.dark ? '#111' : '#FFF'} /></Pressable>
        </View>)}
        {documents.map(doc => <View key={doc.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 54, maxWidth: 220, paddingLeft: 10, paddingRight: 6, borderRadius: 12, backgroundColor: t.surface2 }}>
          <Icon name="document-text-outline" size={20} color={t.accent} />
          <View style={{ flexShrink: 1 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{doc.name}</Text><Text style={{ color: t.muted, fontSize: 10 }}>{doc.pages ? `${doc.pages} стр. · ` : ''}{doc.truncated ? 'прочитано начало' : 'прочитан'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Убрать документ ${doc.name}`} hitSlop={8} onPress={() => setDocuments(list => list.filter(other => other.name !== doc.name))} style={{ padding: 4 }}><Icon name="close" size={15} color={t.muted} /></Pressable>
        </View>)}
        {reading ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 54, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.surface2 }}><ActivityIndicator size="small" color={t.accent} /><Text style={{ color: t.muted, fontSize: 12 }}>Читаю документ…</Text></View> : null}
      </ScrollView> : null}
      {ai.state.pending ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 4 }}><ActivityIndicator color={t.accent} /><Text style={{ flex: 1, color: t.muted, fontSize: 13 }}>AI думает…</Text><Pressable accessibilityRole="button" accessibilityLabel="Отменить ожидание" onPress={() => ai.conversation.current?.cancel()} style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.text }}><Icon name="stop" size={18} color={t.dark ? '#111' : '#FFF'} /></Pressable></View>
        : expanded ? <>
          <ComposerInput accessibilityLabel={mode === 'code' ? 'Задача по коду для AI' : 'Вопрос AI'} value={draft} onChangeText={setDraft} onKeyPress={e => { if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !(e.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) { e.preventDefault(); submit(); } }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} autoFocus={focused} placeholder={mode === 'code' ? 'Опиши задачу по коду' : 'Спроси что угодно'} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} multiline maxLength={inputLimit} style={{ minHeight: 44, maxHeight: 160, paddingHorizontal: 10, paddingTop: 10, color: t.text, fontSize: 17, lineHeight: 23 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{plusButton}{modelPill}<View style={{ flex: 1 }} />{sendButton}</View>
        </> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{plusButton}<Pressable accessibilityRole="button" accessibilityLabel={mode === 'code' ? 'Написать задачу по коду' : 'Написать вопрос AI'} onPress={() => setFocused(true)} style={{ flex: 1, height: 42, justifyContent: 'center', paddingHorizontal: 6 }}><Text numberOfLines={1} style={{ color: t.muted, fontSize: 17 }}>{mode === 'code' ? 'Опиши задачу по коду' : 'Спроси что угодно'}</Text></Pressable>{modelPill}{sendButton}</View>}
    </View>}
    <Sheet visible={toolsSheet} title="Вложения" onClose={() => { afterTools.current = null; setToolsSheet(false); }} onClosed={() => { const next = afterTools.current; afterTools.current = null; next?.(); }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 6, paddingBottom: 8 }}>Всё в одном чате: приложи фото, видео или документ и спроси о них. Попроси «нарисуй…» — AI нарисует, «сделай из этого аниме» с фото — перерисует.</Text>
        <Pressable accessibilityRole="button" onPress={() => { afterTools.current = full ? () => void attachPictures() : () => setPlatinaSheet('Фото и видео'); setToolsSheet(false); }} disabled={!vision} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 6, borderRadius: 14, backgroundColor: pressed ? t.surface2 : 'transparent', opacity: vision ? 1 : .4 })}><Icon name="images-outline" size={22} color={t.text} /><Text style={{ flex: 1, color: t.text, fontSize: 16 }}>Фото и видео</Text>{!full ? <Icon name="lock-closed" size={14} color={t.muted} /> : null}</Pressable>
        <Pressable accessibilityRole="button" onPress={() => { afterTools.current = full ? () => void attachDocuments() : () => setPlatinaSheet('Документ'); setToolsSheet(false); }} disabled={!docs} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 6, borderRadius: 14, backgroundColor: pressed ? t.surface2 : 'transparent', opacity: docs ? 1 : .4 })}><Icon name="document-text-outline" size={22} color={t.text} /><Text style={{ flex: 1, color: t.text, fontSize: 16 }}>Документ</Text>{!full ? <Icon name="lock-closed" size={14} color={t.muted} /> : null}</Pressable>
        <Pressable accessibilityRole="button" onPress={() => { afterTools.current = full ? () => void transcribeFile() : () => setPlatinaSheet('Аудиофайл → текст'); setToolsSheet(false); }} disabled={!(router && !!ai.status?.capabilities.transcribe.enabled)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 6, borderRadius: 14, backgroundColor: pressed ? t.surface2 : 'transparent', opacity: (router && !!ai.status?.capabilities.transcribe.enabled) ? 1 : .4 })}><Icon name="mic-outline" size={22} color={t.text} /><Text style={{ flex: 1, color: t.text, fontSize: 16 }}>Аудиофайл → текст</Text>{!full ? <Icon name="lock-closed" size={14} color={t.muted} /> : null}</Pressable>
        {!router ? <View style={{ paddingTop: 8 }}><AIUnavailableTools status={ai.status} checking={ai.checking} /></View> : null}
      </View>
    </Sheet>
    <Sheet visible={consentSheet} title="Отправить вопрос AI?" onClose={() => { afterConsent.current = null; setConsentSheet(false); }} onClosed={() => { const next = afterConsent.current; afterConsent.current = null; next?.(); }}>
      <View style={{ gap: 12 }}>
        <Text style={help}>Вопросы и история этой беседы передаются через твой сервер {ai.status?.provider === 'freellmapi' ? 'в сервис FreeLLMAPI и бесплатному поставщику модели, которого он выберет' : 'в OpenRouter и поставщику модели'}. В AI попадает только то, что ты пишешь и прикладываешь здесь: текст, фото и кадры видео (без геометки и других данных EXIF) и текст приложенных документов. Разрешение действует только для этой беседы.</Text>
        <Text style={help}>{history ? (incognito ? 'Это приватная беседа: на устройстве она не сохранится.' : 'История бесед хранится зашифрованной только на этом устройстве.') : 'В быстром вопросе история очищается при закрытии окна.'}</Text>
        {ai.status?.provider !== 'freellmapi' ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://openrouter.ai/privacy')} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}><Text style={{ color: t.accent, fontSize: 12 }}>Конфиденциальность OpenRouter</Text></Pressable> : null}
        <Button label="Разрешить и отправить" icon="arrow-up-outline" onPress={() => { ai.conversation.current?.setConsent(true); setConsentSheet(false); }} />
        <Button secondary label="Отмена" onPress={() => { afterConsent.current = null; setConsentSheet(false); }} />
      </View>
    </Sheet>
    <Sheet visible={!!platinaSheet} title={platinaSheet ? `${platinaSheet} — с Platina` : 'Platina'} onClose={() => setPlatinaSheet('')}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><PlatinaGem size={18} /><Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: '600' }}>Доступно только с подпиской Инвиз Platina</Text></View>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>Без Platina AI отвечает на текстовые вопросы быстрой моделью. С Platina — выбор моделей, код, вопросы по фото, картинки, видео, озвучка и расшифровка аудио.</Text>
        <Button label="Подробнее о Platina" icon="diamond-outline" onPress={() => { setPlatinaSheet(''); setTimeout(() => openPlatinaShowcase(), 300); }} />
      </View>
    </Sheet>
    <Sheet visible={historySheet} title="История AI" onClose={() => setHistorySheet(false)}>
      {history?.items.length ? history.items.map(item => <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable accessibilityRole="button" onPress={() => openConversation(item)} style={({ pressed }) => ({ flex: 1, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 16, backgroundColor: item.id === conversationId ? t.accentSoft : pressed ? t.surface2 : 'transparent', gap: 4 })}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{item.title}</Text>
          <Text style={{ color: t.muted, fontSize: 11 }}>{formatListTime(item.updatedAt)} · {item.turns.length} {item.turns.length === 1 ? 'вопрос' : item.turns.length < 5 ? 'вопроса' : 'вопросов'}</Text>
        </Pressable>
        <IconButton name="trash-outline" label={`Удалить беседу ${item.title}`} color={t.danger} size={19} onPress={() => { history.remove(item.id); void deleteAIMedia(mediaUris(item.turns)); if (item.id === conversationId) clear(); }} />
      </View>) : <Text style={{ color: t.muted, fontSize: 13 }}>Пока нет сохранённых бесед.</Text>}
    </Sheet>
    <CodeApproval preview={approval?.preview || null} allowed={ready && ai.state.consent && !ai.state.pending} onCancel={() => setApproval(null)} onApprove={approveCode} />
  </KeyboardSafeView>;
}

export function AIQuickDialog({ api, visible, onClose }: { api: Api; visible: boolean; onClose: () => void }) {
  if (!visible) return null;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={onClose}><GlassStage><SafeAreaView style={{ flex: 1 }}><AIScreen api={api} onBack={onClose} quick /></SafeAreaView></GlassStage></Modal>;
}
