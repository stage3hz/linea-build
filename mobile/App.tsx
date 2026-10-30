import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, View, useColorScheme, useWindowDimensions } from 'react-native';
import { Text } from './src/typography';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Api, ApiError } from './src/api';
import { AuthScreen, ConnectScreen } from './src/AuthScreen';
import { ChatListScreen, MessengerTabs } from './src/ChatListScreen';
import { ChatScreen } from './src/ChatScreen';
import { SavedScreen } from './src/saved/SavedScreen';
import { PeopleScreen } from './src/PeopleScreen';
import { ProfileScreen } from './src/ProfileScreen';
import { SecurityScreen } from './src/SecurityScreen';
import { RecoveryNotice } from './src/RecoveryNotice';
import { Button, Empty, Icon, Logo, Notice, Sheet, SheetAction } from './src/components';
import { clearServer, normalizeServer, readCachedUser, readDarkTheme, readServer, readTheme, readToken, writeCachedUser, writeDarkTheme, writeServer, writeTheme, writeToken } from './src/storage';
import { ThemeContext, palette, useTheme } from './src/theme';
import type { DarkTheme, Session, ThemeMode, User } from './src/types';
import { resolveTheme } from './src/themePreference';
import { THEME_NAMES, ThemeSettings } from './src/ThemeSettings';
import { useMessenger } from './src/useMessenger';
import { GlassStage, GlassSurface } from './src/glass';
import { MusicProvider } from './src/music/MusicProvider';
import { MusicScreen } from './src/music/MusicScreen';
import { FullPlayerHost, MiniPlayer } from './src/music/PlayerControls';
import { SettingsScreen } from './src/SettingsScreen';
import { SERVER_URL } from './src/serverConfig';
import { AIScreen, AIQuickDialog } from './src/ai/AIScreen';
import { clearPhotoCache } from './src/photo/pipeline';
import { clearVideoCache } from './src/media/pipeline';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useSharedValue } from 'react-native-reanimated';
import { MotionRoot } from './src/motion';
import { StackBase, StackScreen } from './src/stack';
import { CommunitiesScreen } from './src/communities/CommunitiesScreen';
import { InviteSheet } from './src/communities/InviteSheet';
import { inviteCodeFrom } from './src/communities/types';
import { onNavigate } from './src/navigation';
import { CallProvider } from './src/calls/CallProvider';
import { GlassBackdrop } from './src/glass';

export default function App() {
  const system=useColorScheme();const [mode,setMode]=useState<ThemeMode>('system');const [darkTheme,setDarkTheme]=useState<DarkTheme>('dark');const [themeError,setThemeError]=useState('');const themeSaveRevision=useRef(0);const [server,setServer]=useState<string|null>(null);const [session,setSession]=useState<Session|null>(null);const [booting,setBooting]=useState(true);const [bootError,setBootError]=useState('');const [authNotice,setAuthNotice]=useState('');
  const logoutInProgress=useRef(false);
  const securityInProgress=useRef(false);const pendingSecurityExpiry=useRef(false);
  const currentAuth=useRef({server,token:session?.token});currentAuth.current={server,token:session?.token};
  const [guestMusicOpen,setGuestMusicOpen]=useState(false);
  const theme=palette[resolveTheme(mode,darkTheme,system)];
  const api=useMemo(()=>new Api(server||'',session?.token),[server,session?.token]);
  const initialize=useCallback(async()=>{
    setBooting(true);setBootError('');
    try{
      const [savedServer,savedTheme,savedDarkTheme,token]=await Promise.all([readServer(),readTheme(),readDarkTheme(),readToken()]);setMode(savedTheme);setDarkTheme(savedDarkTheme);
      // The server address is fixed in the app (api.invizent.com); a saved older address is ignored.
      void savedServer;const base=normalizeServer(SERVER_URL);setServer(base);
      if(base&&token){
        // Telegram-like start: open right away with the last known profile, refresh it in the background.
        const cached=await readCachedUser<{user:User;securitySetupRequired:boolean}>();
        if(cached?.user?.id){
          setSession({token,user:cached.user,securitySetupRequired:!!cached.securitySetupRequired});setBooting(false);
          void new Api(base,token).me().then(({user,securitySetupRequired})=>{setSession(current=>current?.token===token?{token,user,securitySetupRequired}:current);void writeCachedUser({user,securitySetupRequired});})
            .catch(error=>{if(error instanceof ApiError&&error.status===401&&currentAuth.current.token===token){currentAuth.current={server:base,token:undefined};void writeToken(null).catch(()=>{});setSession(null);setAuthNotice('Сессия завершилась. Войди снова.');}});
          return;
        }
        try{const {user,securitySetupRequired}=await new Api(base,token).me();setSession({token,user,securitySetupRequired});void writeCachedUser({user,securitySetupRequired});}
        catch(error){if(error instanceof ApiError&&error.status===401){await writeToken(null);setAuthNotice('Сессия завершилась. Войди снова.');}else throw error;}
      }
    }catch(error){setBootError(error instanceof Error?error.message:'Не удалось открыть приложение.');}
    finally{setBooting(false);}
  },[]);
  useEffect(()=>{void initialize();},[initialize]);
  useEffect(()=>{void clearPhotoCache().catch(()=>{});void clearVideoCache().catch(()=>{});},[]);
  useEffect(()=>{if(!guestMusicOpen||session)return;const sub=BackHandler.addEventListener('hardwareBackPress',()=>{setGuestMusicOpen(false);return true;});return()=>sub.remove();},[guestMusicOpen,session]);
  useEffect(()=>{if(Platform.OS==='web'&&typeof document!=='undefined'){document.title='Инвиз — личные разговоры';document.body.style.backgroundColor=theme.bg;}},[theme.bg]);
  const connect=async(base:string)=>{await writeToken(null);await writeServer(base);setSession(null);setServer(base);setBootError('');setAuthNotice('');};
  const login=async(next:Session)=>{if(currentAuth.current.server!==server)return;if(server)await writeServer(server);if(currentAuth.current.server!==server)return;await writeToken(next.token);void writeCachedUser({user:next.user,securitySetupRequired:next.securitySetupRequired});securityInProgress.current=false;pendingSecurityExpiry.current=false;setGuestMusicOpen(false);setSession(next);setAuthNotice('');};
  const changeServer=async()=>{await writeToken(null);await clearServer();setSession(null);setServer(null);setBootError('');setAuthNotice('');};
  const logout=async()=>{
    logoutInProgress.current=true;
    let revokeError:unknown=null;
    try {
      try {await api.logout();}
      catch(error) {if(!(error instanceof ApiError&&error.status===401))revokeError=error;}
      try {await writeToken(null);}
      catch {throw new Error('Не удалось удалить сохранённую сессию с устройства. Выход не завершён. Попробуй ещё раз.');}
      setSession(null);
      currentAuth.current={server,token:undefined};securityInProgress.current=false;pendingSecurityExpiry.current=false;
      setAuthNotice(revokeError?(revokeError instanceof ApiError?'Выход выполнен на этом устройстве. Сервер не подтвердил отзыв удалённой сессии.':'Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось.'):'');
    } finally {logoutInProgress.current=false;}
  };
  const expired=(ownerToken?:string)=>{if(!currentAuth.current.token||(ownerToken&&currentAuth.current.token!==ownerToken)||logoutInProgress.current)return;if(securityInProgress.current){pendingSecurityExpiry.current=true;return;}currentAuth.current={server,token:undefined};void writeToken(null).catch(()=>{});setSession(null);setAuthNotice('Сессия завершилась. Войди снова.');};
  const securityPending=(pending:boolean)=>{if(!session||currentAuth.current.token!==session.token)return;securityInProgress.current=pending;if(!pending&&pendingSecurityExpiry.current){pendingSecurityExpiry.current=false;expired(session.token);}};
  const credentialsChanged=async(message:string)=>{
    if(!session||currentAuth.current.token!==session.token)return;
    let storageNotice='';
    try{await writeToken(null);}catch{storageNotice=' Сохранённую копию отозванной сессии не удалось удалить с устройства; сервер больше её не принимает.';}
    if(currentAuth.current.token!==session.token)return;
    securityInProgress.current=false;pendingSecurityExpiry.current=false;currentAuth.current={server,token:undefined};setSession(null);setAuthNotice(message+storageNotice);
  };
  const saveThemePreference=(pending:Promise<void>)=>{const revision=++themeSaveRevision.current;setThemeError('');void pending.catch(()=>{if(revision===themeSaveRevision.current)setThemeError('Оформление изменено, но не сохранилось на устройстве. Выбери его ещё раз, чтобы повторить сохранение.');});};
  const changeTheme=(value:ThemeMode)=>{setMode(value);saveThemePreference(writeTheme(value));};
  const changeDarkTheme=(value:DarkTheme)=>{setDarkTheme(value);saveThemePreference(writeDarkTheme(value));};
  return <GestureHandlerRootView style={{flex:1}}><KeyboardProvider statusBarTranslucent navigationBarTranslucent><SafeAreaProvider><MotionRoot/><ThemeContext.Provider value={theme}><GlassStage><StatusBar style={theme.dark?'light':'dark'}/><MusicProvider key={`${server||'unconfigured'}:${session?.user.id||'guest'}`}><SafeAreaView style={{flex:1,backgroundColor:'transparent'}}>
    {themeError?<View style={{padding:12}}><Notice text={themeError} error/></View>:null}
    {booting?<View style={{flex:1}}/>:guestMusicOpen&&!session?<MusicScreen onBack={()=>setGuestMusicOpen(false)}/>:bootError?<View style={{flex:1}}><ThemeAccess mode={mode} darkTheme={darkTheme} onChange={changeTheme} onDarkTheme={changeDarkTheme} onMusic={()=>setGuestMusicOpen(true)}/><View style={{flex:1,justifyContent:'center',padding:28}}><View style={{maxWidth:420,width:'100%',alignSelf:'center',gap:17}}><Empty icon="cloud-offline-outline" title="Не получилось подключиться" description={bootError}/><Button label="Повторить" onPress={()=>void initialize()} icon="refresh-outline"/></View></View></View>:!server?<View style={{flex:1}}><ThemeAccess mode={mode} darkTheme={darkTheme} onChange={changeTheme} onDarkTheme={changeDarkTheme} onMusic={()=>setGuestMusicOpen(true)}/><ConnectScreen onConnect={connect}/></View>:!session?<View style={{flex:1}}><ThemeAccess mode={mode} darkTheme={darkTheme} onChange={changeTheme} onDarkTheme={changeDarkTheme} onMusic={()=>setGuestMusicOpen(true)}/>{authNotice?<View style={{padding:14,paddingBottom:0}}><Notice text={authNotice}/></View>:null}<AuthScreen key={server} api={api} onLogin={login} onChangeServer={()=>void changeServer()}/></View>:<Messenger key={`${server}:${session.user.id}`} api={api} session={session} onUser={user=>setSession(current=>current?.token===session.token&&current.user.id===user.id?{...current,user}:current)} themeMode={mode} darkTheme={darkTheme} onTheme={changeTheme} onDarkTheme={changeDarkTheme} onLogout={logout} onExpired={()=>expired(session.token)} onCredentialsChanged={credentialsChanged} onSensitiveActionPending={securityPending}/>}
    {!booting&&!session&&!guestMusicOpen?<MiniPlayer onOpen={()=>setGuestMusicOpen(true)}/>:null}
  </SafeAreaView><FullPlayerHost onSource={(url:string)=>{void Linking.openURL(url).catch(()=>{});}}/></MusicProvider></GlassStage></ThemeContext.Provider></SafeAreaProvider></KeyboardProvider></GestureHandlerRootView>;
}

function ThemeAccess({mode,darkTheme,onChange,onDarkTheme,onMusic}:{mode:ThemeMode;darkTheme:DarkTheme;onChange:(value:ThemeMode)=>void;onDarkTheme:(value:DarkTheme)=>void;onMusic:()=>void}) {
  const t=useTheme();const [visible,setVisible]=useState(false);
  return <><View style={{minHeight:58,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10,paddingHorizontal:20,paddingVertical:7}}><GlassSurface radius={24} material="clear" shadow={false}><Pressable accessibilityRole="button" accessibilityLabel="Открыть музыку без регистрации" onPress={onMusic} style={{minHeight:44,paddingHorizontal:14,flexDirection:'row',alignItems:'center',gap:8}}><Icon name="headset-outline" size={18} color={t.accent}/><Text style={{color:t.accent,fontSize:12,fontWeight:'700'}}>Музыка</Text></Pressable></GlassSurface><GlassSurface radius={24} material="clear" shadow={false}><Pressable accessibilityRole="button" accessibilityLabel={`Оформление: ${THEME_NAMES[mode]}`} onPress={()=>setVisible(true)} style={{minHeight:44,paddingHorizontal:14,flexDirection:'row',alignItems:'center',gap:8}}><Icon name={mode==='system'?'contrast-outline':mode==='light'?'sunny-outline':'moon-outline'} size={17} color={t.text}/><Text style={{color:t.text,fontSize:12,fontWeight:'600'}}>{THEME_NAMES[mode]}</Text><Icon name="chevron-down" size={12} color={t.muted}/></Pressable></GlassSurface></View><Sheet visible={visible} title="Оформление" onClose={()=>setVisible(false)}><ThemeSettings mode={mode} darkTheme={darkTheme} onChange={onChange} onDarkTheme={onDarkTheme}/></Sheet></>;
}

function Messenger({api,session,onUser,themeMode,darkTheme,onTheme,onDarkTheme,onLogout,onExpired,onCredentialsChanged,onSensitiveActionPending}: {api:Api;session:Session;onUser:(user:User)=>void;themeMode:ThemeMode;darkTheme:DarkTheme;onTheme:(mode:ThemeMode)=>void;onDarkTheme:(mode:DarkTheme)=>void;onLogout:()=>Promise<void>;onExpired:()=>void;onCredentialsChanged:(message:string)=>Promise<void>;onSensitiveActionPending:(pending:boolean)=>void}) {
  const t=useTheme();const {width}=useWindowDimensions();const wide=width>=850;const store=useMessenger(api,session.user,onExpired);const [page,setPage]=useState<'chats'|'saved'|'people'|'channels'|'music'|'ai'|'profile'|'security'|'settings'>(session.securitySetupRequired?'security':'chats');
  const [openCommunity,setOpenCommunity]=useState<string|null>(null);const [inviteCode,setInviteCode]=useState<string|null>(null);
  const [quickAI,setQuickAI]=useState(false);
  const chat=store.chats.find(c=>c.id===store.selectedId);
  const goBack=()=>{if(page==='security'||page==='profile')setPage('settings');else if(page==='saved')setPage('chats');else if(page!=='chats')setPage('chats');else store.selectChat(null);};
  useEffect(()=>{const sub=BackHandler.addEventListener('hardwareBackPress',()=>{if(page==='channels'&&openCommunity){setOpenCommunity(null);return true;}if(page==='security'||page==='profile'){setPage('settings');return true;}if(page!=='chats'){setPage('chats');return true;}if(store.selectedId){store.selectChat(null);return true;}return false;});return()=>sub.remove();},[page,store.selectedId,store.selectChat,openCommunity]);
  const newChat=()=>{store.selectChat(null);setPage('people');};
  // Channels: open a community, or an invite from a banner / a linea://invite/… link.
  useEffect(()=>onNavigate(request=>{if(request.to==='invite'){setInviteCode(request.code);return;}store.selectChat(null);setPage('channels');setOpenCommunity(request.communityId??null);}),[store.selectChat]);
  useEffect(()=>{const handle=(url:string|null)=>{const code=url?inviteCodeFrom(url):null;if(code)setInviteCode(code);};void Linking.getInitialURL().then(handle).catch(()=>{});const sub=Linking.addEventListener('url',event=>handle(event.url));return()=>sub.remove();},[]);
  const profile=()=>{store.selectChat(null);setPage('settings');};
  const openMusic=()=>{store.selectChat(null);setPage('music');};
  const openAI=()=>{store.selectChat(null);setPage('ai');};
  const openChats=()=>{store.selectChat(null);setPage('chats');};
  const openSaved=()=>{store.selectChat(null);setPage('saved');};
  const listStore={...store,selectChat:(selected:Parameters<typeof store.selectChat>[0])=>{setPage('chats');store.selectChat(selected);}};
  const stackProgress=useSharedValue(1);
  // Narrow screens: a chat or Избранное is pushed over the chat list, which stays mounted underneath.
  const pushed:null|'saved'|'chat'=wide?null:page==='saved'?'saved':page==='chats'&&chat?'chat':null;
  const pushedScreen=pushed?<StackScreen key={pushed==='chat'?`chat:${chat!.id}`:'saved'} progress={stackProgress} onBack={goBack}>{back=><View style={{flex:1}}><StackBackdrop/>{pushed==='saved'?<SavedScreen api={api} user={session.user} store={store} onBack={back} wide={wide}/>:<ChatScreen key={chat!.id} api={api} user={session.user} chat={chat!} store={store} onBack={back} wide={wide} onOpenMusic={openMusic}/>}</View>}</StackScreen>:null;
  // Narrow screens: Профиль and Безопасность are pushed over Настройки, with the same swipe back.
  const settingsProgress=useSharedValue(1);
  const settingsScreen=<SettingsScreen api={api} user={session.user} theme={themeMode} darkTheme={darkTheme} onTheme={onTheme} onDarkTheme={onDarkTheme} onBack={goBack} onProfile={()=>setPage('profile')} onSecurity={()=>setPage('security')} onMusic={openMusic} onLogout={onLogout}/>;
  const settingsChild=page==='profile'||page==='security'?page:null;
  const settingsStack=<View style={{flex:1}}><StackBase progress={settingsProgress} covered={!!settingsChild}>{settingsScreen}</StackBase>{settingsChild?<StackScreen key={settingsChild} progress={settingsProgress} onBack={goBack}>{back=><View style={{flex:1}}><StackBackdrop/>{settingsChild==='security'?<SecurityScreen api={api} onBack={back} onCredentialsChanged={onCredentialsChanged} onSensitiveActionPending={onSensitiveActionPending}/>:<ProfileScreen api={api} user={session.user} theme={themeMode} darkTheme={darkTheme} onTheme={onTheme} onDarkTheme={onDarkTheme} onUser={onUser} onBack={back} onLogout={onLogout} onSecurity={()=>setPage('security')}/>}</View>}</StackScreen>:null}</View>;
  const detail=page==='channels'?<CommunitiesScreen api={api} me={session.user} store={store} openId={openCommunity} onOpened={setOpenCommunity} onOpenInvite={setInviteCode}/>:!wide&&(page==='settings'||page==='profile'||page==='security')?settingsStack:page==='saved'?<SavedScreen api={api} user={session.user} store={store} onBack={goBack} wide={wide}/>:page==='security'?<SecurityScreen api={api} onBack={goBack} onCredentialsChanged={onCredentialsChanged} onSensitiveActionPending={onSensitiveActionPending}/>:page==='ai'?<AIScreen api={api} onBack={goBack} history={store.aiHistory}/>:page==='music'?<MusicScreen onBack={goBack}/>:page==='people'?<PeopleScreen api={api} onBack={goBack} onOpen={newChat=>{setPage('chats');store.selectChat(newChat);}}/>:page==='settings'?<SettingsScreen api={api} user={session.user} theme={themeMode} darkTheme={darkTheme} onTheme={onTheme} onDarkTheme={onDarkTheme} onBack={goBack} onProfile={()=>setPage('profile')} onSecurity={()=>setPage('security')} onMusic={openMusic} onLogout={onLogout}/>:page==='profile'?<ProfileScreen api={api} user={session.user} theme={themeMode} darkTheme={darkTheme} onTheme={onTheme} onDarkTheme={onDarkTheme} onUser={onUser} onBack={goBack} onLogout={onLogout} onSecurity={()=>setPage('security')}/>:chat?<ChatScreen key={chat.id} api={api} user={session.user} chat={chat} store={store} onBack={goBack} wide={wide}/>:<View style={{flex:1,backgroundColor:t.chatBg,justifyContent:'center',alignItems:'center'}}><Empty icon="chatbubbles-outline" title="Важное — между вами" description="Выбери разговор или найди человека, которому давно хотел написать." action={<Button label="Начать разговор" onPress={newChat} icon="add"/>}/></View>;
  if(!wide&&(page==='chats'||page==='saved'))return <CallProvider api={api} store={store} me={session.user}><View style={{flex:1,width:'100%'}}><RecoveryNotice requests={store.recoveryRequests} error={store.recoveryError} onRefresh={store.refreshRecoveryRequests} onCancel={store.cancelRecovery}/><View style={{flex:1}}><StackBase progress={stackProgress} covered={!!pushed}><ChatListScreen api={api} user={session.user} store={listStore} onNewChat={newChat} onProfile={profile} onMusic={openMusic} onAI={openAI} onQuickAI={()=>setQuickAI(true)} onChats={openChats} onSaved={openSaved} savedActive={page==='saved'} activeTab={page==='saved'?'chats':page}/></StackBase>{pushedScreen}</View><AIQuickDialog api={api} visible={quickAI} onClose={()=>setQuickAI(false)}/><InviteSheet api={api} code={inviteCode} onClose={()=>setInviteCode(null)} onJoined={id=>{setInviteCode(null);store.selectChat(null);setPage('channels');setOpenCommunity(id);}}/></View></CallProvider>;
  return <CallProvider api={api} store={store} me={session.user}><View style={{flex:1,width:'100%',maxWidth:1440,alignSelf:'center'}}><RecoveryNotice requests={store.recoveryRequests} error={store.recoveryError} onRefresh={store.refreshRecoveryRequests} onCancel={store.cancelRecovery}/><View style={{flex:1,flexDirection:'row',borderLeftWidth:wide?1:0,borderRightWidth:wide?1:0,borderColor:t.border}}>{wide||(!chat&&page==='chats')?<View style={{width:wide?360:'100%',borderRightWidth:wide?1:0,borderColor:t.border}}><ChatListScreen api={api} user={session.user} store={listStore} onNewChat={newChat} onProfile={profile} onMusic={openMusic} onAI={openAI} onQuickAI={()=>setQuickAI(true)} onChats={openChats} onSaved={openSaved} savedActive={page==='saved'} activeTab={page==='security'||page==='settings'?'profile':page==='saved'?'chats':page}/></View>:null}{wide||chat||page!=='chats'?<View style={{flex:1}}>{detail}</View>:null}</View>{!wide&&page!=='chats'&&page!=='saved'?<MessengerTabs onNewChat={newChat} onProfile={profile} onMusic={openMusic} onAI={openAI} onChats={openChats} activeTab={page==='security'||page==='settings'?'profile':page}/>:null}{page!=='music'&&!wide&&page==='chats'&&chat?<MiniPlayer onOpen={openMusic}/>:null}<AIQuickDialog api={api} visible={quickAI} onClose={()=>setQuickAI(false)}/><InviteSheet api={api} code={inviteCode} onClose={()=>setInviteCode(null)} onJoined={id=>{setInviteCode(null);store.selectChat(null);setPage('channels');setOpenCommunity(id);}}/></View></CallProvider>;
}

/** Background of a pushed screen. It reaches under the status bar and home indicator so the gradient
 * lines up with the app background and no seam shows at the safe-area edges. */
function StackBackdrop(){
  const insets=useSafeAreaInsets();
  return <View pointerEvents="none" style={{position:'absolute',top:-insets.top,bottom:-insets.bottom,left:0,right:0}}><GlassBackdrop/></View>;
}
