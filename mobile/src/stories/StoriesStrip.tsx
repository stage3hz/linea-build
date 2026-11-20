// The stories strip above the chat list (Telegram): «Моя история» first (a «+» adds one), then friends who
// have a live story — those with something unseen first, a bright ring; all watched, a grey ring. A tap
// opens the viewer, which runs on to the next friend when one person's stories end; a swipe sideways moves
// between people (back from someone's first story goes to the previous person's last). The strip is hidden
// while nobody (me included) has a story: only the «+» would be left. The server builds the feed and decides
// who is in it (canSeePosts): friends, and people I sent a friend request to that is still waiting when they
// show their stories and posts to everyone — those carry a small clock on the avatar and «заявка» under the
// name. A person without a live story who published a post («запись») in the last 48 hours is here too: a tap
// opens the post in the same viewer, and «запись» stands under the name. The server has no "seen" state for
// posts, so a post is unseen until it is opened once on this device (stories/seenPosts). A reply is an ordinary end-to-end encrypted message to the author with
// a story reference (meta.story) inside the encrypted payload (the server sees ciphertext only).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Text } from '../typography';
import { Avatar, Icon, Notice } from '../components';
import { useTheme } from '../theme';
import { PostViewer, StoryRing, pickAndUpload } from '../ProfilePosts';
import { lightFeedback } from '../haptics';
import { hasUnseen, markPostsSeen, stripOrder, useSeenPosts } from './seenPosts';
import type { Api, ProfilePost, StoriesFeed, StoryFeedItem } from '../api';
import type { PendingMessage, User } from '../types';
import type { MessengerStore } from '../useMessenger';

const AVATAR = 56;
/** How often the strip re-reads the feed on its own (new stories also arrive over the socket). */
const REFRESH_MS = 5 * 60_000;
const failureText = (failure: unknown, fallback: string) => failure instanceof Error && failure.message ? failure.message : fallback;
/** Polls `read` until it returns a value or `timeout` ms pass: the store's state reaches us only on the next render. */
async function settled<T>(read: () => T | undefined, timeout: number): Promise<T | undefined> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read(); if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

export function StoriesStrip({ api, user, store }: { api: Api; user: User; store: MessengerStore }) {
  const t = useTheme();
  const [feed, setFeed] = useState<StoriesFeed | null>(null);
  // Whose stories are open: my own (user.id) or a friend's (their user id). An id, not an index: the feed
  // may be re-read (socket, timer) while the viewer is open, and the order changes as stories are watched.
  const [viewing, setViewing] = useState<string | null>(null);
  // Which way the viewer moved to the person shown: forward starts at their first unseen story, back
  // (a swipe right or a tap on the left of someone's first story) at their last one, as in Telegram.
  const [entered, setEntered] = useState<1 | -1>(1);
  const open = (id: string | null, from: 1 | -1 = 1) => { setEntered(from); setViewing(id); };
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true);
  const seenPosts = useSeenPosts(user.id);
  // The latest store state for the reply flow, which awaits across renders.
  const chatsRef = useRef(store.chats); chatsRef.current = store.chats;
  const pendingRef = useRef(store.pending); pendingRef.current = store.pending;
  const load = useCallback(() => api.storiesFeed().then(result => { if (alive.current) setFeed(result); }).catch(() => {}), [api]);
  useEffect(() => {
    alive.current = true; void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const off = store.onSocket((data: { type?: string }) => { if (data?.type === 'story' || data?.type === 'story.view') void load(); });
    return () => { alive.current = false; clearInterval(timer); off(); };
  }, [load, store.onSocket]);

  const add = async () => {
    if (busy) return; setBusy(true); setError('');
    try { const uploadId = await pickAndUpload(api); if (uploadId) { await api.publishPost(uploadId, 'story'); await load(); } }
    catch (failure) { setError(failureText(failure, 'Не удалось добавить историю.')); }
    finally { setBusy(false); }
  };
  // A watched story is marked on the server and in the strip at once (the ring turns grey without a reload).
  const viewed = (item: StoryFeedItem, post: ProfilePost) => {
    if (post.seen) return;
    void api.viewStory(post.id).catch(() => {});
    setFeed(current => current ? { ...current, items: current.items.map(entry => entry.user.id !== item.user.id ? entry : { ...entry, unseen: Math.max(0, entry.unseen - 1), stories: entry.stories.map(story => story.id === post.id ? { ...story, seen: true } : story) }) } : current);
  };
  /**
   * Answers a story: an end-to-end encrypted message to the author with the story reference in the
   * ciphertext (the chat shows a «История» quote above it). Without a chat with the author one is created
   * first and the chat list re-read — sending needs the chat in the store (it holds the peer to encrypt
   * for). The promise settles with the real outcome: it rejects when the message could not be sent.
   */
  const reply = async (author: User, text: string, post: ProfilePost) => {
    const find = () => chatsRef.current.find(entry => entry.peer.id === author.id);
    let chat = find();
    if (!chat) {
      await api.createChat(author.id);
      await store.refreshChats();
      chat = await settled(find, 3000);
      if (!chat) throw new Error('Не удалось открыть чат с автором.');
    }
    const item: PendingMessage = { clientId: Crypto.randomUUID(), chatId: chat.id, text, attachment: null, state: 'sending', createdAt: new Date().toISOString(), meta: { story: { id: post.id, ownerId: author.id } } };
    // `retry` is the store's send itself, awaitable; it records a failure in the pending list rather than throwing.
    await store.retry(item);
    const outcome = await settled(() => { const found = pendingRef.current.find(entry => entry.clientId === item.clientId); return !found ? 'sent' : found.state === 'failed' ? found : undefined; }, 1500);
    if (outcome && outcome !== 'sent') throw new Error(outcome.error || 'Не удалось отправить ответ.');
  };

  if (!feed || (!feed.items.length && !feed.mine.length)) return error ? <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}><Notice text={error} error /></View> : null;
  const mineSeen = feed.mine.length > 0;
  const own = viewing === user.id;
  // People with something unseen first (a post counts as unseen until opened here once), then the rest.
  const people = stripOrder(feed.items, seenPosts);
  const shown = viewing === null || own ? null : people.find(item => item.user.id === viewing) ?? null;
  // What the viewer plays for the person: their live stories, or — when there are none — their recent posts.
  const postsShown = !!shown && !shown.stories.length;
  const current = viewing === null ? null : own ? { user, stories: feed.mine } : shown ? { user: shown.user, stories: postsShown ? shown.posts ?? [] : shown.stories } : null;
  // The people in the strip's order: «Моя история» (when there is one), then the others.
  const order = [...(feed.mine.length ? [user.id] : []), ...people.map(item => item.user.id)];
  const at = viewing === null ? -1 : order.indexOf(viewing);
  const before = at > 0 ? order[at - 1] : null, after = at >= 0 && at + 1 < order.length ? order[at + 1] : null;
  const start = !current ? 0 : entered < 0 ? current.stories.length - 1 : own || postsShown ? 0 : Math.max(0, current.stories.findIndex(story => !story.seen));
  const label = (text: string) => <Text numberOfLines={1} style={{ color: t.text, fontSize: 12, fontWeight: '600', maxWidth: AVATAR + 16, textAlign: 'center' }}>{text}</Text>;
  return <View style={{ paddingBottom: 6 }}>
    {error ? <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}><Notice text={error} error /></View> : null}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 12, gap: 6, alignItems: 'flex-start' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={mineSeen ? 'Моя история' : 'Добавить историю'} disabled={busy} onPress={() => { lightFeedback(); if (mineSeen) open(user.id); else void add(); }} onLongPress={() => void add()} delayLongPress={350}
        style={({ pressed }) => ({ alignItems: 'center', gap: 5, width: AVATAR + 24, opacity: pressed ? .75 : 1 })}>
        <View style={{ width: AVATAR + 12, height: AVATAR + 12, alignItems: 'center', justifyContent: 'center' }}>
          <StoryRing active={mineSeen} size={AVATAR}><Avatar user={user} api={api} size={AVATAR} round /></StoryRing>
          <Pressable accessibilityRole="button" accessibilityLabel="Добавить историю" disabled={busy} onPress={() => void add()} hitSlop={6} style={{ position: 'absolute', right: 0, bottom: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: t.accent, borderWidth: 2, borderColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
            {busy ? <ActivityIndicator size="small" color={t.onAccent} /> : <Icon name="add" size={14} color={t.onAccent} />}
          </Pressable>
        </View>
        {label('Моя история')}
      </Pressable>
      {people.map(item => {
        const post = !item.stories.length; const fresh = hasUnseen(item, seenPosts);
        const state = post ? ', запись' : item.unseen ? `, новых историй: ${item.unseen}` : ', истории просмотрены';
        return <Pressable key={item.user.id} accessibilityRole="button" accessibilityLabel={`${item.user.displayName}${state}${item.pending ? ', заявка' : ''}`} onPress={() => { lightFeedback(); open(item.user.id); }}
          style={({ pressed }) => ({ alignItems: 'center', gap: 5, width: AVATAR + 24, opacity: pressed ? .75 : 1 })}>
          <View style={{ width: AVATAR + 12, height: AVATAR + 12, alignItems: 'center', justifyContent: 'center' }}>
            <StoryRing active seen={!fresh} size={AVATAR}><Avatar user={item.user} api={api} size={AVATAR} round /></StoryRing>
            {/* Not a friend yet: my request to this person is still waiting. */}
            {item.pending ? <View pointerEvents="none" style={{ position: 'absolute', right: 0, bottom: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: t.surface, borderWidth: 2, borderColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="time-outline" size={13} color={t.muted} />
            </View> : null}
          </View>
          <View style={{ alignItems: 'center', gap: 1 }}>
            {label(item.user.displayName.trim().split(/\s+/)[0] || item.user.displayName)}
            {/* «запись» for a post, «заявка» for a waiting request (the clock stays when it is both); nothing for a friend's story. */}
            {post || item.pending ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11, maxWidth: AVATAR + 16, textAlign: 'center' }}>{post ? 'запись' : 'заявка'}</Text> : null}
          </View>
        </Pressable>;
      })}
    </ScrollView>
    {/* One viewer for the whole strip: moving to another person swaps its stories in place (`group`), with
        the page sliding in from the side the finger pushed towards, instead of closing and reopening the modal. */}
    {current && current.stories.length ? <PostViewer api={api} items={current.stories} start={start} story={!postsShown} group={current.user.id} enterFrom={entered}
      owner={current.user} own={own} onClose={() => setViewing(null)}
      onView={own || !shown || postsShown ? undefined : post => viewed(shown, post)}
      // A post opened once is seen from now on (on this device): the ring turns grey and the person moves back.
      onShown={postsShown ? post => markPostsSeen(user.id, [post.id]) : undefined}
      onReply={own || postsShown ? undefined : (text, post) => reply(current.user, text, post)}
      // At the end of one person's stories or posts the viewer runs on to the next (from mine to the first
      // person); after the last one it closes. A swipe right on someone's first story goes back to the previous person.
      onFinished={() => open(after, 1)}
      onPrevious={before ? () => open(before, -1) : undefined} /> : null}
  </View>;
}
