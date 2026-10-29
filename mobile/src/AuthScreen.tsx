import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text } from './typography';
import { Api, ApiError } from './api';
import { Button, Field, Icon, IconButton, Logo, Notice } from './components';
import { GlassSurface } from './glass';
import { useTheme } from './theme';
import { isDevelopmentHttpAllowed, normalizeServer } from './storage';
import type { RecoveryChallenge, Session } from './types';
import { ManualField } from './auth/ManualField';
import { clearRecovery, readRecovery, saveRecovery } from './auth/recoveryStorage';

export function ConnectScreen({initialUrl='',onConnect}: {initialUrl?:string;onConnect:(url:string)=>Promise<void>}) {
  const t=useTheme();const [url,setUrl]=useState(initialUrl);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const connect=async()=>{setError('');setBusy(true);try{const base=normalizeServer(url);const result=await new Api(base).health();if(result.status!=='ok')throw new Error('Этот адрес не похож на сервер Инвиза.');await onConnect(base);}catch(e){setError(e instanceof Error?e.message:'Не удалось подключиться.');}finally{setBusy(false);}};
  return <KeyboardAvoidingView style={{flex:1,backgroundColor:'transparent'}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{flexGrow:1,justifyContent:'center',paddingHorizontal:22,paddingVertical:32}}>
      <View style={{width:'100%',maxWidth:440,alignSelf:'center'}}>
        <View style={{flexDirection:'row',alignItems:'center',gap:12,paddingHorizontal:6,marginBottom:32}}><Logo size={43}/><Text style={{color:t.text,fontSize:25,fontWeight:'800',letterSpacing:-1}}>Инвиз</Text></View>
        <View style={{paddingHorizontal:6,marginBottom:26,gap:13}}><Text style={{fontSize:39,lineHeight:45,fontWeight:'800',letterSpacing:-1.7,color:t.text}}>Ближе.{ '\n' }Даже на расстоянии.</Text><Text style={{color:t.muted,fontSize:15,lineHeight:23,maxWidth:340}}>Место для твоих разговоров. Подключись, чтобы войти или создать аккаунт.</Text></View>
        <GlassSurface material="regular" radius={30} contentStyle={{padding:23,gap:18}}>
          <View style={{flexDirection:'row',gap:10,alignItems:'center'}}><View style={{height:34,width:34,borderRadius:12,alignItems:'center',justifyContent:'center',backgroundColor:t.accentSoft}}><Icon name="link-outline" size={19} color={t.accent}/></View><Text style={{color:t.text,fontSize:17,fontWeight:'700'}}>Подключение</Text></View>
          <Field label="Адрес сервера" value={url} onChangeText={setUrl} placeholder="https://chat.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={()=>void connect()} editable={!busy}/>
          {error?<Notice text={error} error/>:null}
          <Button label="Продолжить" icon="arrow-forward" onPress={()=>void connect()} loading={busy} disabled={!url.trim()}/>
          <Text style={{color:t.muted,fontSize:12,lineHeight:19}}>{isDevelopmentHttpAllowed()?'Для локальной разработки введи адрес компьютера в Wi-Fi, например http://192.168.1.10:3001.':'Подключение к серверу защищено HTTPS. Введите адрес вашего сервера с действующим сертификатом.'}</Text>
        </GlassSurface>
        <Text style={{fontSize:12,lineHeight:19,color:t.subtle,textAlign:'center',marginTop:25}}>Твоя линия связи.</Text>
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

export function normalizeRecoveryWord(value: string) {
  return value.trim().normalize('NFC').toLowerCase();
}
export function newPasswordError(value: string) {
  const count=Array.from(value.normalize('NFC')).length;
  if(count<15||count>128)return 'Новый пароль: от 15 до 128 символов. Можно использовать длинную фразу.';
  if(/[\u0000-\u001f\u007f]/.test(value))return 'В пароле есть недопустимый символ.';
  return '';
}
export function recoveryWordError(value:string,password='',username='',otherWord='') {
  const word=normalizeRecoveryWord(value);
  if(!/^[a-zа-яё]{4,64}$/u.test(word))return 'Слово: от 4 до 64 русских или английских букв, без пробелов.';
  if(word===normalizeRecoveryWord(password)||word===username.trim().toLowerCase()||word===normalizeRecoveryWord(otherWord))return 'Два слова должны отличаться друг от друга, пароля и ника.';
  return '';
}
export function SecretInput({label,value,onChangeText,placeholder,disabled=false,onSubmit}: {
  label:string;value:string;onChangeText:(value:string)=>void;placeholder?:string;disabled?:boolean;
  newPassword?:boolean;word?:boolean;onSubmit?:()=>void;
}) {
  const t=useTheme();const [visible,setVisible]=useState(false);
  useEffect(()=>{if(!value)setVisible(false);},[value]);
  return <View style={{gap:8}}>
    <Text style={{fontSize:11,fontWeight:'700',letterSpacing:1,color:t.muted,textTransform:'uppercase',paddingLeft:2}}>{label}</Text>
    <View style={{position:'relative'}}>
      <ManualField accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder={placeholder} secureTextEntry={!visible}
        editable={!disabled} style={{paddingRight:58}} returnKeyType={onSubmit?'go':'next'} onSubmitEditing={onSubmit}/>
      <View style={{position:'absolute',right:5,top:5}}><IconButton name={visible?'eye-off-outline':'eye-outline'} label={`${visible?'Скрыть':'Показать'}: ${label.toLowerCase()}`} onPress={()=>setVisible(current=>!current)} color={t.muted} disabled={disabled}/></View>
    </View>
  </View>;
}

type Mode='login-name'|'login-password'|'login-word'|'register-name'|'register-password'|'register-confirmation'|'register-recovery'|'recover'|'waiting'|'reset';
type RecoveryFeedback={username:string;remaining?:number;lockedUntil?:number};
const validUsername=(value:string)=>/^[a-z0-9_]{3,24}$/.test(value.trim().toLowerCase());
const formatCountdown=(until:number,now:number)=>{
  const seconds=Math.max(0,Math.ceil((until-now)/1000));
  return `${Math.floor(seconds/3600)?`${String(Math.floor(seconds/3600)).padStart(2,'0')}:`:''}${String(Math.floor(seconds%3600/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
};
const loginSteps:Mode[]=['login-name','login-password','login-word'];
const registerSteps:Mode[]=['register-name','register-password','register-confirmation','register-recovery'];

export function AuthScreen({api,onLogin,onChangeServer}: {api:Api;onLogin:(session:Session)=>Promise<void>;onChangeServer:()=>void}) {
  const t=useTheme();const [mode,setMode]=useState<Mode>('login-name');
  const [username,setUsername]=useState(''),[usernameRepeat,setUsernameRepeat]=useState('');
  const [password,setPassword]=useState(''),[passwordRepeat,setPasswordRepeat]=useState('');
  const [confirmationWord,setConfirmationWord]=useState(''),[confirmationRepeat,setConfirmationRepeat]=useState('');
  const [recoveryWord,setRecoveryWord]=useState(''),[recoveryRepeat,setRecoveryRepeat]=useState('');
  const [challenge,setChallenge]=useState<RecoveryChallenge|null>(null),[serverOffset,setServerOffset]=useState(0);
  const [busy,setBusy]=useState(false),[restoring,setRestoring]=useState(true),[checking,setChecking]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[feedback,setFeedback]=useState<RecoveryFeedback|null>(null),[clock,setClock]=useState(Date.now);
  const alive=useRef(false),generation=useRef(0),pending=useRef(false),statusPending=useRef(false),statusGeneration=useRef(0);
  const challengeRef=useRef<RecoveryChallenge|null>(null),modeRef=useRef<Mode>(mode);
  challengeRef.current=challenge;modeRef.current=mode;
  const login=username.trim().toLowerCase(),isRegister=registerSteps.includes(mode),isLogin=loginSteps.includes(mode);
  const recoveryFeedback=feedback?.username===login?feedback:null;
  const locked=!!recoveryFeedback?.lockedUntil&&recoveryFeedback.lockedUntil>clock;
  const current=(id:number)=>alive.current&&generation.current===id;
  const clearSecrets=()=>{setPassword('');setPasswordRepeat('');setConfirmationWord('');setConfirmationRepeat('');setRecoveryWord('');setRecoveryRepeat('');};
  const forgetGrant=()=>{setChallenge(null);challengeRef.current=null;};

  useEffect(()=>{
    alive.current=true;const life=++generation.current;
    clearSecrets();forgetGrant();setUsername('');setUsernameRepeat('');setMode('login-name');setError('');setNotice('');setFeedback(null);setBusy(false);pending.current=false;statusGeneration.current++;statusPending.current=false;setChecking(false);setRestoring(true);
    void readRecovery(api.base).then(saved=>{
      if(!current(life)||!saved)return;
      setUsername(saved.username);setChallenge(saved.challenge);challengeRef.current=saved.challenge;setMode('waiting');
      setServerOffset(Date.parse(saved.challenge.serverTime)-Date.now());
      setNotice('Запрос восстановления найден. Проверяем его состояние на сервере.');
    }).catch(()=>{if(current(life))setNotice('Не удалось прочитать сохранённый запрос восстановления. Можно начать новый запрос.');})
      .finally(()=>{if(current(life))setRestoring(false);});
    return()=>{alive.current=false;generation.current++;challengeRef.current=null;};
  },[api.base]);
  useEffect(()=>{
    if(mode!=='recover'&&mode!=='waiting'&&mode!=='reset')return;
    setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);
  },[mode]);

  const begin=()=>{if(pending.current||restoring)return null;pending.current=true;setBusy(true);setError('');setNotice('');return ++generation.current;};
  const finish=(id:number)=>{if(current(id)){pending.current=false;setBusy(false);}};
  const usernameCheck=()=>{if(validUsername(username))return true;setError('Ник: 3–24 символа — латинские буквы, цифры и знак _.');return false;};
  const go=(next:Mode)=>{setError('');setNotice('');setMode(next);};
  const switchFlow=(register:boolean)=>{
    if(pending.current||restoring)return;
    generation.current++;clearSecrets();setUsername('');setUsernameRepeat('');go(register?'register-name':'login-name');
  };
  const acceptSession=async(session:Session,id:number)=>{
    if(!current(id)){void new Api(api.base,session.token).logout().catch(()=>{});return;}
    try{await onLogin(session);}
    catch(reason){void new Api(api.base,session.token).logout().catch(()=>{});throw reason;}
  };
  const signIn=async()=>{
    if(!usernameCheck())return;
    if(!password||Array.from(password).length>128){setError('Введи свой пароль. Максимум — 128 символов.');return;}
    // Empty confirmation is sent unchanged for legacy accounts. Only the server
    // decides whether an account may enter without a configured word.
    const id=begin();if(id===null)return;
    try{await acceptSession(await api.login(login,password,normalizeRecoveryWord(confirmationWord)),id);}
    catch(reason){if(current(id)){setConfirmationWord('');setError(reason instanceof Error?reason.message:'Не удалось войти.');}}
    finally{finish(id);}
  };
  const registerNext=async()=>{
    if(pending.current)return;
    if(mode==='register-name'){
      if(!usernameCheck())return;
      if(login!==usernameRepeat.trim().toLowerCase()){setError('Ники не совпадают. Введи оба вручную ещё раз.');return;}
      go('register-password');return;
    }
    if(mode==='register-password'){
      const invalid=newPasswordError(password);if(invalid){setError(invalid);return;}
      if(password!==passwordRepeat){setError('Пароли не совпадают. Проверь повторный ввод.');return;}
      go('register-confirmation');return;
    }
    if(mode==='register-confirmation'){
      const invalid=recoveryWordError(confirmationWord,password,login);if(invalid){setError(invalid);return;}
      if(normalizeRecoveryWord(confirmationWord)!==normalizeRecoveryWord(confirmationRepeat)){setError('Слова подтверждения не совпадают.');return;}
      go('register-recovery');return;
    }
    const invalid=recoveryWordError(recoveryWord,password,login,confirmationWord);if(invalid){setError(invalid);return;}
    if(normalizeRecoveryWord(recoveryWord)!==normalizeRecoveryWord(recoveryRepeat)){setError('Слова восстановления не совпадают.');return;}
    const id=begin();if(id===null)return;
    try{await acceptSession(await api.register(login,password,login,normalizeRecoveryWord(confirmationWord),normalizeRecoveryWord(recoveryWord)),id);}
    catch(reason){if(current(id))setError(reason instanceof Error?reason.message:'Не удалось создать аккаунт.');}
    finally{finish(id);}
  };
  const verifyRecovery=async()=>{
    if(locked||!usernameCheck())return;
    const invalid=recoveryWordError(recoveryWord);if(invalid){setError(invalid);return;}
    const id=begin();if(id===null)return;
    try{
      const result=await api.verifyRecovery(login,normalizeRecoveryWord(recoveryWord));
      if(!current(id))return;
      if(!result.resetToken||!result.requestId||![result.readyAt,result.expiresAt,result.serverTime].every(value=>Number.isFinite(Date.parse(value))))throw new Error('Сервер вернул некорректное подтверждение. Попробуй ещё раз.');
      clearSecrets();setChallenge(result);challengeRef.current=result;setServerOffset(Date.parse(result.serverTime)-Date.now());setFeedback(null);setClock(Date.now());
      try{await saveRecovery(api.base,login,result);}catch{if(current(id))setNotice('Не удалось сохранить запрос на устройстве. Оставь этот экран открытым до окончания ожидания.');}
      if(current(id))setMode('waiting');
    }catch(reason){
      if(!current(id))return;
      setRecoveryWord('');setError(reason instanceof Error?reason.message:'Не удалось подтвердить слово восстановления.');
      if(reason instanceof ApiError){
        const remaining=typeof reason.attemptsRemaining==='number'?Math.max(0,Math.min(3,reason.attemptsRemaining)):undefined;
        const seconds=typeof reason.retryAfterSeconds==='number'?Math.max(0,reason.retryAfterSeconds):undefined;
        if(remaining!==undefined||seconds!==undefined)setFeedback({username:login,remaining,lockedUntil:seconds?Date.now()+seconds*1000:undefined});
        setClock(Date.now());
      }
    }finally{finish(id);}
  };
  const checkRecovery=async()=>{
    const grant=challengeRef.current,life=generation.current;
    if(!grant||statusPending.current||pending.current||modeRef.current!=='waiting')return;
    const statusRequest=++statusGeneration.current;statusPending.current=true;setChecking(true);
    try{
      const status=await api.recoveryStatus(grant.resetToken);
      if(!current(life)||challengeRef.current?.resetToken!==grant.resetToken||modeRef.current!=='waiting')return;
      if(status.requestId!==grant.requestId||!['ready','waiting'].includes(status.status)||![status.readyAt,status.expiresAt,status.serverTime].every(value=>Number.isFinite(Date.parse(value))))throw new Error('Не удалось проверить состояние запроса.');
      const updated={...grant,readyAt:status.readyAt,expiresAt:status.expiresAt,serverTime:status.serverTime};
      setChallenge(updated);challengeRef.current=updated;setServerOffset(Date.parse(status.serverTime)-Date.now());setClock(Date.now());setError('');
      if(status.status==='ready'){setNotice('Сервер разрешил сменить пароль. Оба секретных слова останутся прежними.');setMode('reset');}
    }catch(reason){
      if(!current(life)||challengeRef.current?.resetToken!==grant.resetToken)return;
      if(reason instanceof ApiError&&(reason.status===401||reason.status===410)){
        await clearRecovery(api.base,grant.resetToken).catch(()=>{});
        if(!current(life))return;
        clearSecrets();forgetGrant();setMode('recover');setNotice('Запрос отменён, уже использован или его срок закончился. Можно начать восстановление заново.');setError('');
      }else setError(reason instanceof Error?reason.message:'Нет связи с сервером. Повторим проверку.');
    }finally{if(statusRequest===statusGeneration.current){statusPending.current=false;if(current(life))setChecking(false);}}
  };
  useEffect(()=>{
    if(mode!=='waiting'||!challenge?.resetToken||restoring)return;
    void checkRecovery();const timer=setInterval(()=>void checkRecovery(),10000);return()=>clearInterval(timer);
  },[mode,challenge?.resetToken,restoring]);
  useEffect(()=>{
    if(mode!=='reset'||!challenge||pending.current||Date.parse(challenge.expiresAt)>clock+serverOffset)return;
    const grant=challenge;clearSecrets();forgetGrant();setMode('recover');setError('Время для смены пароля закончилось. Начни восстановление заново.');
    void clearRecovery(api.base,grant.resetToken).catch(()=>{});
  },[mode,challenge,clock,serverOffset]);

  const resetPassword=async()=>{
    const grant=challengeRef.current;if(!grant){clearSecrets();go('recover');return;}
    const invalid=newPasswordError(password);if(invalid){setError(invalid);return;}
    if(password!==passwordRepeat){setError('Пароли не совпадают. Проверь повторный ввод.');return;}
    const id=begin();if(id===null)return;
    try{
      await api.resetPassword(grant.resetToken,password);
      await clearRecovery(api.base,grant.resetToken).catch(()=>{});
      if(!current(id))return;
      clearSecrets();forgetGrant();setFeedback(null);setUsername('');setUsernameRepeat('');setMode('login-name');setNotice('Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и прежним словом подтверждения.');
    }catch(reason){
      if(!current(id))return;
      if(reason instanceof ApiError&&reason.code==='RECOVERY_WAIT'){clearSecrets();setMode('waiting');}
      if(reason instanceof ApiError&&(reason.status===401||reason.status===410)){
        await clearRecovery(api.base,grant.resetToken).catch(()=>{});if(!current(id))return;clearSecrets();forgetGrant();setMode('recover');
      }
      setError(reason instanceof Error?reason.message:'Не удалось изменить пароль.');
    }finally{finish(id);}
  };
  const leaveRecovery=async(changeServer=false)=>{
    if(pending.current||restoring)return;
    const grant=challengeRef.current,id=begin();if(id===null)return;
    try{
      await clearRecovery(api.base,grant?.resetToken);
      if(!current(id))return;
      clearSecrets();forgetGrant();setUsername('');setUsernameRepeat('');setMode('login-name');setError('');setNotice('');
      if(changeServer)onChangeServer();
    }catch{if(current(id))setError('Не удалось удалить сохранённый запрос. Попробуй ещё раз.');}
    finally{finish(id);}
  };
  const back=()=>{
    if(pending.current||restoring)return;
    if(mode==='waiting'||mode==='reset'){void leaveRecovery();return;}
    generation.current++;setError('');setNotice('');
    if(mode==='login-word'){setConfirmationWord('');setPassword('');setMode('login-password');return;}
    if(mode==='login-password'){clearSecrets();setMode('login-name');return;}
    if(mode==='register-recovery'){setRecoveryWord('');setRecoveryRepeat('');setMode('register-confirmation');return;}
    if(mode==='register-confirmation'){setConfirmationWord('');setConfirmationRepeat('');setMode('register-password');return;}
    if(mode==='register-password'){clearSecrets();setMode('register-name');return;}
    clearSecrets();setUsername('');setUsernameRepeat('');setMode('login-name');
  };
  const submit=async()=>{
    if(pending.current||restoring)return;
    if(isRegister){await registerNext();return;}
    if(mode==='login-name'){if(usernameCheck())go('login-password');return;}
    if(mode==='login-password'){if(!password||Array.from(password).length>128){setError('Введи свой пароль. Максимум — 128 символов.');return;}go('login-word');return;}
    if(mode==='login-word'){await signIn();return;}
    if(mode==='recover'){await verifyRecovery();return;}
    if(mode==='waiting'){await checkRecovery();return;}
    if(mode==='reset')await resetPassword();
  };
  const titles:Record<Mode,string>={
    'login-name':'Сначала —\nтвой ник.','login-password':'Теперь\nтвой пароль.','login-word':'Слово, которое\nзнаешь ты.',
    'register-name':'Твой Инвиз.\nТвой ник.','register-password':'Придумай\nдлинный пароль.','register-confirmation':'Слово\nдля каждого входа.','register-recovery':'Другое слово.\nНа случай потери.',
    recover:'Вернём\nдоступ.',waiting:'Пауза\nдля защиты.',reset:'Новый пароль.\nТвой Инвиз.'};
  const descriptions:Record<Mode,string>={
    'login-name':'Вход без почты и номера телефона. Данные проверим вместе на последнем шаге.',
    'login-password':'Введи пароль вручную. Следом понадобится слово подтверждения.',
    'login-word':'Введи слово подтверждения, которое выбрал при регистрации.',
    'register-name':'Каждое значение вводится дважды вручную. Это поможет заметить опечатку.',
    'register-password':'От 15 до 128 символов. Длинная фраза тоже подходит.',
    'register-confirmation':'Это слово нужно при входе после пароля. Оно должно отличаться от ника и пароля.',
    'register-recovery':'Это отдельное слово понадобится, если забудешь пароль. Оно должно отличаться от первого.',
    recover:'Введи ник и слово восстановления. После подтверждения нужно будет подождать 10 минут.',
    waiting:'Слово восстановления подтверждено. Через 10 минут сервер разрешит задать новый пароль.',
    reset:'Введи новый пароль дважды вручную. Слово подтверждения и слово восстановления сохранятся.'};
  const step=isRegister?registerSteps.indexOf(mode)+1:isLogin?loginSteps.indexOf(mode)+1:0;
  const stepCount=isRegister?4:3;
  const buttonTitle=mode==='register-recovery'?'Создать аккаунт':mode==='login-word'?'Войти в Инвиз':mode==='recover'?'Подтвердить слово':mode==='waiting'?'Проверить статус':mode==='reset'?'Сохранить новый пароль':'Продолжить';
  const disabled=busy||restoring;
  const wordHelp=<Text style={{color:t.muted,fontSize:12,lineHeight:18}}>От 4 до 64 русских или английских букв, без пробелов. Регистр не важен; «е» и «ё» различаются.</Text>;

  return <KeyboardAvoidingView style={{flex:1,backgroundColor:'transparent'}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{flexGrow:1,justifyContent:'center',paddingHorizontal:22,paddingVertical:25}}>
      <View style={{width:'100%',maxWidth:440,alignSelf:'center'}}>
        <View style={{flexDirection:'row',alignItems:'center',gap:12,marginBottom:23,paddingHorizontal:6}}><Logo size={43}/><Text style={{color:t.text,fontSize:25,fontWeight:'800',letterSpacing:-1,flex:1}}>Инвиз</Text><View style={{flexDirection:'row',alignItems:'center',gap:5}}><Icon name="shield-checkmark-outline" color={t.muted} size={16}/><Text style={{color:t.muted,fontSize:10}}>Без почты и SMS</Text></View></View>
        <View style={{paddingHorizontal:6,marginBottom:22}}><Text style={{color:t.text,fontSize:35,lineHeight:40,fontWeight:'800',letterSpacing:-1.3}}>{titles[mode]}</Text><Text style={{color:t.muted,fontSize:14,lineHeight:21,marginTop:12}}>{descriptions[mode]}</Text></View>
        <GlassSurface material="regular" radius={30} contentStyle={{padding:21,gap:18}}>
          {isLogin||isRegister?<View style={{flexDirection:'row',padding:4,backgroundColor:t.dark?'rgba(0,0,0,0.18)':'rgba(97,113,149,0.08)',borderRadius:19,borderWidth:1,borderColor:t.border}}>
            {[{title:'Войти',register:false},{title:'Создать аккаунт',register:true}].map(tab=><Pressable key={tab.title} disabled={disabled} onPress={()=>switchFlow(tab.register)} accessibilityRole="tab" accessibilityState={{selected:isRegister===tab.register}} style={{flex:1,minHeight:43,alignItems:'center',justifyContent:'center',borderRadius:15,borderWidth:1,borderColor:isRegister===tab.register?t.glassBorder:'transparent',backgroundColor:isRegister===tab.register?(t.dark?'rgba(255,255,255,0.12)':'rgba(255,255,255,0.82)'):'transparent'}}><Text style={{color:isRegister===tab.register?t.text:t.muted,fontWeight:isRegister===tab.register?'700':'500',fontSize:12}}>{tab.title}</Text></Pressable>)}
          </View>:null}
          {step?<View style={{flexDirection:'row',alignItems:'center',gap:8}}>{Array.from({length:stepCount},(_,index)=><View key={index} style={{height:4,flex:1,borderRadius:4,backgroundColor:index<step?t.accent:t.border}}/>)}<Text style={{color:t.muted,fontSize:11,marginLeft:5}}>{step} / {stepCount}</Text></View>:null}
          {restoring?<View style={{padding:15,alignItems:'center',gap:10}}><ActivityIndicator color={t.accent}/><Text style={{color:t.muted,fontSize:12}}>Проверяем сохранённый запрос…</Text></View>:null}
          {mode==='login-name'||mode==='register-name'||mode==='recover'?<ManualField label="Ник" value={username} onChangeText={setUsername} placeholder="например, vladik" maxLength={24} editable={!disabled} returnKeyType={mode==='login-name'?'go':'next'} onSubmitEditing={mode==='login-name'?()=>void submit():undefined}/>:null}
          {mode==='register-name'?<ManualField label="Повтори ник" value={usernameRepeat} onChangeText={setUsernameRepeat} placeholder="Введи тот же ник вручную" maxLength={24} editable={!disabled} returnKeyType="go" onSubmitEditing={()=>void submit()}/>:null}
          {mode==='login-password'||mode==='register-password'||mode==='reset'?<SecretInput label={mode==='reset'?'Новый пароль':'Пароль'} value={password} onChangeText={setPassword} placeholder={mode==='login-password'?'Твой пароль':'От 15 символов — можно фразу'} disabled={disabled} onSubmit={mode==='login-password'?()=>void submit():undefined}/>:null}
          {mode==='register-password'||mode==='reset'?<SecretInput label={mode==='reset'?'Повтори новый пароль':'Повтори пароль'} value={passwordRepeat} onChangeText={setPasswordRepeat} placeholder="Введи тот же пароль вручную" disabled={disabled} onSubmit={()=>void submit()}/>:null}
          {mode==='login-word'||mode==='register-confirmation'?<>
            <SecretInput label="Слово подтверждения" value={confirmationWord} onChangeText={setConfirmationWord} placeholder="Твоё слово для входа" disabled={disabled} word onSubmit={mode==='login-word'?()=>void submit():undefined}/>
            {mode==='register-confirmation'?<>{wordHelp}<SecretInput label="Повтори слово подтверждения" value={confirmationRepeat} onChangeText={setConfirmationRepeat} placeholder="Введи то же слово вручную" disabled={disabled} word onSubmit={()=>void submit()}/></>:<Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Если в старом аккаунте слово ещё не настроено, оставь поле пустым. После входа сможешь добавить его в безопасности.</Text>}
          </>:null}
          {mode==='register-recovery'||mode==='recover'?<>
            <SecretInput label="Слово восстановления" value={recoveryWord} onChangeText={setRecoveryWord} placeholder="Отдельное слово для восстановления" disabled={disabled||locked&&mode==='recover'} word onSubmit={mode==='recover'?()=>void submit():undefined}/>
            {wordHelp}
            {mode==='register-recovery'?<><SecretInput label="Повтори слово восстановления" value={recoveryRepeat} onChangeText={setRecoveryRepeat} placeholder="Введи то же слово вручную" disabled={disabled} word onSubmit={()=>void submit()}/><Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Запомни оба слова и храни их отдельно. В приложении их нельзя будет посмотреть повторно.</Text></>:<Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Всего 3 неверные попытки, затем восстановление блокируется на 24 часа. Вход с паролем и словом подтверждения остаётся доступен.</Text>}
          </>:null}
          {mode==='waiting'&&challenge?<View style={{gap:14}}>
            <View style={{alignItems:'center',paddingVertical:16,gap:10}}><Icon name="time-outline" size={30} color={t.accent}/><Text accessibilityLabel="Осталось до проверки сервером" style={{color:t.text,fontSize:43,fontWeight:'700',letterSpacing:1,fontVariant:['tabular-nums']}}>{formatCountdown(Date.parse(challenge.readyAt),clock+serverOffset)}</Text><Text style={{color:t.muted,fontSize:12,textAlign:'center'}}>Запрос для @{login}</Text></View>
            <Text style={{color:t.muted,fontSize:12,lineHeight:19}}>На устройствах с открытым аккаунтом этот запрос можно отменить. Если запрос сохранён, можно закрыть приложение и вернуться. Готовность проверяется на сервере каждые 10 секунд.</Text>
            <Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Переход ко входу удалит запрос с этого устройства. Продолжить его здесь после этого не получится.</Text>
          </View>:null}
          {mode==='reset'&&challenge?<Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Подтверждение действительно ещё {formatCountdown(Date.parse(challenge.expiresAt),clock+serverOffset)}.</Text>:null}
          {mode==='recover'&&locked?<Notice text={`Восстановление временно заблокировано. Повторная попытка через ${formatCountdown(recoveryFeedback!.lockedUntil!,clock)}. Ограничение действует на сервере.`} error/>:mode==='recover'&&recoveryFeedback?.remaining!==undefined&&recoveryFeedback.remaining>0?<Text accessibilityLiveRegion="polite" style={{color:t.muted,fontSize:12}}>По ответу сервера осталось попыток: {recoveryFeedback.remaining} из 3.</Text>:null}
          {mode!=='waiting'?<Text style={{color:t.subtle,fontSize:11,lineHeight:17}}>Только ручной ввод. Вставка и автозаполнение отключены.</Text>:null}
          {api.base.startsWith('http:')?<Notice text="Тестовое подключение без шифрования. Для настоящего аккаунта нужен HTTPS."/>:null}
          {notice?<Notice text={notice}/>:null}{error?<Notice text={error} error/>:null}
          <Button label={buttonTitle} icon={mode==='waiting'?'refresh-outline':mode==='recover'?'key-outline':'arrow-forward'} onPress={()=>void submit()} loading={busy||checking&&mode==='waiting'} disabled={restoring||mode==='recover'&&locked}/>
          {isLogin?<Pressable disabled={disabled} accessibilityRole="button" onPress={()=>{generation.current++;clearSecrets();go('recover');}} style={{minHeight:44,alignItems:'center',justifyContent:'center'}}><Text style={{color:t.accent,fontSize:13,fontWeight:'700'}}>Забыл пароль?</Text></Pressable>:null}
          {mode!=='login-name'&&mode!=='register-name'?<Pressable disabled={disabled} accessibilityRole="button" onPress={back} style={{minHeight:44,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6}}><Icon name="chevron-back" color={t.muted} size={15}/><Text style={{color:t.muted,fontSize:13}}>{mode==='recover'||mode==='waiting'||mode==='reset'?'Вернуться ко входу':'Назад'}</Text></Pressable>:null}
        </GlassSurface>
        <Pressable disabled={disabled} onPress={()=>void leaveRecovery(true)} accessibilityRole="button" accessibilityLabel="Сменить сервер" style={{marginTop:15,alignSelf:'center',padding:12,flexDirection:'row',gap:7,alignItems:'center'}}><Icon name="link-outline" size={14} color={t.muted}/><Text numberOfLines={1} style={{color:t.muted,fontSize:12,maxWidth:245}}>{api.base.replace(/^https?:\/\//,'')}</Text><Icon name="chevron-down" size={12} color={t.muted}/></Pressable>
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
