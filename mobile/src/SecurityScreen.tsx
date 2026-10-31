import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text } from './typography';
import { ApiError, type Api } from './api';
import { Button, Icon, IconButton, Notice, SectionLabel, Sheet } from './components';
import { GlassSurface } from './glass';
import { useTheme } from './theme';
import { AccountZone } from './AccountZone';
import { SecretInput, newPasswordError, normalizeRecoveryWord, recoveryWordError } from './AuthScreen';
import type { DeviceSession, SecurityStatus } from './types';

type Form = 'password' | 'confirmation' | 'word' | null;
type SessionAction = {kind:'one';session:DeviceSession}|{kind:'others'}|null;
const readable = (reason:unknown,fallback:string) => reason instanceof Error?reason.message:fallback;
function sessionDate(value:string) {
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Неизвестно';
}
function deviceIcon(name:string) {
  return /android|iphone|ipad|ios/i.test(name)?'phone-portrait-outline':'desktop-outline';
}

export function SecurityScreen({api,onBack,onCredentialsChanged,onSensitiveActionPending}: {
  api:Api; onBack:()=>void; onCredentialsChanged:(message:string)=>Promise<void>;
  onSensitiveActionPending:(pending:boolean)=>void;
}) {
  const t=useTheme();
  const [status,setStatus]=useState<SecurityStatus|null>(null),[sessions,setSessions]=useState<DeviceSession[]>([]);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [form,setForm]=useState<Form>(null),[action,setAction]=useState<SessionAction>(null),[formError,setFormError]=useState('');
  const [currentPassword,setCurrentPassword]=useState(''),[currentConfirmation,setCurrentConfirmation]=useState(''),[newPassword,setNewPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[word,setWord]=useState('');
  const alive=useRef(false),epoch=useRef(0),loadVersion=useRef(0),pending=useRef(false);
  const valid=useCallback((value:number)=>alive.current&&epoch.current===value,[]);
  const changedCallback=useRef(onCredentialsChanged);changedCallback.current=onCredentialsChanged;
  const clearSecrets=()=>{setCurrentPassword('');setCurrentConfirmation('');setNewPassword('');setConfirmation('');setWord('');};

  const refresh=useCallback(async()=>{
    const life=epoch.current,request=++loadVersion.current;
    setLoading(true);setError('');
    try{
      const [security,result]=await Promise.all([api.security(),api.sessions()]);
      if(!valid(life)||request!==loadVersion.current)return;
      setStatus(security);setSessions(result.sessions);
    }catch(reason){
      if(!valid(life)||request!==loadVersion.current)return;
      setError(reason instanceof ApiError&&reason.status===404?'Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0.':readable(reason,'Не удалось загрузить настройки безопасности.'));
      if(reason instanceof ApiError&&reason.status===401)await changedCallback.current('Сессия завершилась. Войди в аккаунт снова.');
    }finally{if(valid(life)&&request===loadVersion.current)setLoading(false);}
  },[api,valid]);
  useEffect(()=>{
    alive.current=true;epoch.current++;clearSecrets();setStatus(null);setSessions([]);setForm(null);setAction(null);setFormError('');setNotice('');setBusy(false);pending.current=false;void refresh();
    return()=>{alive.current=false;epoch.current++;loadVersion.current++;};
  },[refresh]);

  const openForm=(next:Form)=>{if(pending.current)return;clearSecrets();setFormError('');setNotice('');setForm(next);};
  const closeForm=()=>{if(pending.current)return;clearSecrets();setFormError('');setForm(null);};
  const sensitiveChange=async()=>{
    if(pending.current||!form)return;
    if(!currentPassword||Array.from(currentPassword).length>128){setFormError('Введи текущий пароль.');return;}
    if(status?.confirmationConfigured&&!currentConfirmation.trim()){setFormError('Введи текущее слово подтверждения.');return;}
    const invalid=form==='password'?newPasswordError(newPassword):recoveryWordError(word,currentPassword,'',form==='word'?currentConfirmation:'');
    if(invalid){setFormError(invalid);return;}
    if(form==='password'&&newPassword!==confirmation){setFormError('Новые пароли не совпадают.');return;}
    if(form!=='password'&&normalizeRecoveryWord(word)!==normalizeRecoveryWord(confirmation)){setFormError('Секретные слова не совпадают.');return;}
    const life=epoch.current,target=form;
    pending.current=true;setBusy(true);setFormError('');setError('');
    onSensitiveActionPending(true);
    try{
      const currentWord=normalizeRecoveryWord(currentConfirmation);
      if(target==='password')await api.changePassword(currentPassword,newPassword,currentWord);
      else if(target==='confirmation')await api.changeConfirmationWord(currentPassword,normalizeRecoveryWord(word),currentWord);
      else await api.changeRecoveryWord(currentPassword,normalizeRecoveryWord(word),currentWord);
      if(!valid(life))return;
      clearSecrets();setForm(null);
      await onCredentialsChanged(target==='password'?'Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и словом подтверждения.':target==='confirmation'?'Слово подтверждения сохранено. Все устройства вышли из аккаунта. Используй новое слово при входе.':'Слово восстановления сохранено. Все устройства вышли из аккаунта. Войди с паролем и словом подтверждения.');
    }catch(reason){
      if(valid(life)){setCurrentPassword('');setCurrentConfirmation('');setFormError(readable(reason,'Не удалось изменить настройки. Попробуй ещё раз.'));}
    }finally{
      onSensitiveActionPending(false);
      if(valid(life)){pending.current=false;setBusy(false);}
    }
  };
  const revoke=async()=>{
    if(pending.current||!action)return;
    const selected=action,life=epoch.current;
    const currentSession=selected.kind==='one'&&selected.session.isCurrent;
    pending.current=true;setBusy(true);setError('');setNotice('');
    if(currentSession)onSensitiveActionPending(true);
    try{
      if(selected.kind==='others')await api.revokeOtherSessions();
      else await api.revokeSession(selected.session.id);
      if(!valid(life))return;
      setAction(null);
      if(currentSession){await onCredentialsChanged('Сеанс на этом устройстве завершён. Войди снова, чтобы продолжить.');return;}
      setNotice(selected.kind==='others'?'Все другие сеансы завершены.':'Выбранный сеанс завершён.');
      await refresh();
    }catch(reason){if(valid(life)){setAction(null);setError(readable(reason,'Не удалось завершить сеанс.'));}}
    finally{if(currentSession)onSensitiveActionPending(false);if(valid(life)){pending.current=false;setBusy(false);}}
  };
  const otherCount=sessions.filter(session=>!session.isCurrent).length;

  return <KeyboardAvoidingView style={{flex:1,backgroundColor:'transparent'}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <GlassSurface lens material="clear" radius={27} style={{marginHorizontal:14,marginTop:12,marginBottom:2}} contentStyle={{flexDirection:'row',alignItems:'center',padding:10,gap:9,minHeight:68}}>
      <IconButton name="chevron-back" label="Назад в профиль" onPress={onBack} disabled={busy}/><Text style={{fontSize:20,fontWeight:'700',letterSpacing:-.5,color:t.text,flex:1}}>Безопасность</Text><View style={{paddingRight:10}}><Icon name="shield-checkmark-outline" color={t.accent} size={23}/></View>
    </GlassSurface>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:17,paddingBottom:36,maxWidth:620,width:'100%',alignSelf:'center',gap:16}}>
      <GlassSurface material="clear" radius={28} contentStyle={{padding:22,gap:11}}>
        <Text style={{color:t.text,fontSize:23,lineHeight:28,fontWeight:'800',letterSpacing:-.7}}>Твой доступ.{ '\n' }Твои устройства.</Text>
        <Text style={{color:t.muted,fontSize:13,lineHeight:20}}>Вход по нику, паролю и слову подтверждения. Для восстановления — другое слово. Почта и номер телефона не нужны.</Text>
      </GlassSurface>
      {api.base.startsWith('http:')?<Notice text="Тестовое подключение без шифрования. Для настоящего аккаунта нужен HTTPS."/>:null}
      {error?<Notice text={error} error onRetry={()=>{if(!pending.current)void refresh();}}/>:null}
      {notice?<Notice text={notice}/>:null}
      {loading&&!status?<View style={{padding:30,alignItems:'center',gap:12}}><ActivityIndicator color={t.accent}/><Text style={{color:t.muted,fontSize:13}}>Загружаем настройки…</Text></View>:null}
      {status?<>
        {!status.confirmationConfigured||!status.recoveryConfigured?<Notice text="Заверши настройку двух слов. В старом аккаунте недостающие слова можно добавить, пока помнишь пароль."/>:null}
        <GlassSurface material="regular" radius={28} contentStyle={{padding:20,gap:16}}>
          <SectionLabel>Пароль</SectionLabel>
          <View style={{flexDirection:'row',gap:12,alignItems:'center'}}><Icon name="lock-closed-outline" color={t.accent} size={23}/><Text style={{color:t.muted,fontSize:13,lineHeight:20,flex:1}}>Можно использовать длинную фразу. После смены пароля все сеансы завершатся.</Text></View>
          <Button label="Изменить пароль" secondary icon="key-outline" onPress={()=>openForm('password')} disabled={busy}/>
        </GlassSurface>
        <GlassSurface material="regular" radius={28} contentStyle={{padding:20,gap:15}}>
          <SectionLabel>Подтверждение входа</SectionLabel>
          <View style={{flexDirection:'row',alignItems:'center',gap:11}}><View style={{width:42,height:42,borderRadius:16,alignItems:'center',justifyContent:'center',backgroundColor:t.accentSoft}}><Icon name={status.confirmationConfigured?'checkmark-circle-outline':'key-outline'} color={t.accent} size={25}/></View><View style={{flex:1,gap:4}}><Text style={{color:t.text,fontSize:15,fontWeight:'700'}}>Слово подтверждения</Text><Text style={{color:status.confirmationConfigured?t.accent:t.muted,fontSize:12}}>{status.confirmationConfigured?'Настроено':'Пока не настроено'}</Text></View></View>
          <Text style={{color:t.muted,fontSize:13,lineHeight:20}}>Это слово нужно при каждом входе после пароля. Посмотреть его повторно нельзя.</Text>
          <Button label={status.confirmationConfigured?'Изменить слово подтверждения':'Настроить слово подтверждения'} secondary icon="key-outline" onPress={()=>openForm('confirmation')} disabled={busy}/>
        </GlassSurface>
        <GlassSurface material="regular" radius={28} contentStyle={{padding:20,gap:15}}>
          <SectionLabel>Восстановление доступа</SectionLabel>
          <View style={{flexDirection:'row',alignItems:'center',gap:11}}><View style={{width:42,height:42,borderRadius:16,alignItems:'center',justifyContent:'center',backgroundColor:t.accentSoft}}><Icon name={status.recoveryConfigured?'checkmark-circle-outline':'key-outline'} color={t.accent} size={25}/></View><View style={{flex:1,gap:4}}><Text style={{color:t.text,fontSize:15,fontWeight:'700'}}>Слово восстановления</Text><Text style={{color:status.recoveryConfigured?t.accent:t.muted,fontSize:12}}>{status.recoveryConfigured?'Настроено':'Пока не настроено'}</Text></View></View>
          <Text style={{color:t.muted,fontSize:13,lineHeight:20}}>{status.recoveryConfigured?'Отдельное слово для случая, когда пароль забыт. После его проверки действует 10-минутное ожидание. Открытые сеансы могут отменить запрос.':'Настрой слово сейчас, пока помнишь пароль. Без слова восстановления вернуть доступ через этот экран не получится.'}</Text>
          <View style={{borderRadius:17,padding:13,gap:5,backgroundColor:t.accentSoft}}><Text style={{color:t.text,fontSize:12,fontWeight:'700'}}>3 попытки → 24 часа ожидания</Text><Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Ограничение действует на сервере и относится только к восстановлению. Вход с паролем и словом подтверждения остаётся доступен.</Text></View>
          <Button label={status.recoveryConfigured?'Изменить слово восстановления':'Настроить слово восстановления'} secondary icon="key-outline" onPress={()=>openForm('word')} disabled={busy}/>
        </GlassSurface>
        <GlassSurface material="regular" radius={28} contentStyle={{padding:20,gap:15}}>
          <View style={{flexDirection:'row',alignItems:'center',gap:8}}><View style={{flex:1}}><SectionLabel>Сеансы и устройства</SectionLabel></View><IconButton name="refresh-outline" label="Обновить список сеансов" size={19} disabled={busy||loading} onPress={()=>void refresh()}/></View>
          <Text style={{color:t.muted,fontSize:12,lineHeight:18}}>Здесь показаны действующие входы. Одна платформа может отображаться несколько раз, если ты входил в неё повторно.</Text>
          {sessions.map(session=><View key={session.id} style={{paddingVertical:13,borderTopWidth:1,borderColor:t.border,gap:10}}>
            <View style={{flexDirection:'row',gap:12,alignItems:'flex-start'}}><View style={{width:42,height:42,borderRadius:16,backgroundColor:t.accentSoft,alignItems:'center',justifyContent:'center'}}><Icon name={deviceIcon(session.deviceName)} color={t.accent} size={23}/></View><View style={{flex:1,gap:5}}><Text style={{color:t.text,fontSize:14,fontWeight:'700'}}>{session.deviceName||'Устройство'}</Text>{session.isCurrent?<Text style={{color:t.accent,fontSize:11,fontWeight:'700'}}>Этот сеанс</Text>:null}<Text style={{color:t.muted,fontSize:11,lineHeight:17}}>Активность: {sessionDate(session.lastActiveAt)}{ '\n' }Вход: {sessionDate(session.createdAt)}{ '\n' }Действует до: {sessionDate(session.expiresAt)}</Text></View><IconButton name="log-out-outline" label={`Завершить сеанс: ${session.deviceName}${session.isCurrent?', текущий':''}`} color={t.muted} size={20} disabled={busy} onPress={()=>setAction({kind:'one',session})}/></View>
          </View>)}
          {!sessions.length&&!loading?<Text style={{color:t.muted,fontSize:13}}>Действующие сеансы не найдены.</Text>:null}
          {loading&&status?<ActivityIndicator color={t.accent}/>:null}
          <Button label="Завершить другие сеансы" danger icon="log-out-outline" disabled={busy||!otherCount} onPress={()=>setAction({kind:'others'})}/>
        </GlassSurface>
        <AccountZone api={api} confirmationConfigured={status.confirmationConfigured} onDeleted={()=>changedCallback.current('Аккаунт удалён.')}/>
      </>:null}
      <Text style={{color:t.subtle,fontSize:11,lineHeight:17,textAlign:'center',paddingHorizontal:10}}>Выбирай два разных непредсказуемых слова. Они должны отличаться друг от друга, ника и пароля. Все значения здесь вводятся вручную.</Text>
    </ScrollView>
    <Sheet visible={form!==null} title={form==='password'?'Изменить пароль':form==='confirmation'?'Слово подтверждения':'Слово восстановления'} onClose={closeForm}>
      <View style={{gap:15,paddingBottom:8}}>
        <Text style={{color:t.muted,fontSize:13,lineHeight:20}}>Подтверди текущие данные. После сохранения все устройства выйдут из аккаунта. Новое значение введи дважды вручную.</Text>
        <SecretInput label="Текущий пароль" value={currentPassword} onChangeText={setCurrentPassword} placeholder="Пароль этого аккаунта" disabled={busy}/>
        {status?.confirmationConfigured?<SecretInput label="Текущее слово подтверждения" value={currentConfirmation} onChangeText={setCurrentConfirmation} placeholder="Слово, которое используешь при входе" disabled={busy} word/>:null}
        {form==='password'?<>
          <SecretInput label="Новый пароль" value={newPassword} onChangeText={setNewPassword} placeholder="От 15 до 128 символов" disabled={busy} newPassword/>
          <SecretInput label="Повтори новый пароль" value={confirmation} onChangeText={setConfirmation} placeholder="Для проверки без опечаток" disabled={busy} newPassword onSubmit={()=>void sensitiveChange()}/>
        </>:<>
          <SecretInput label={form==='confirmation'?'Новое слово подтверждения':'Новое слово восстановления'} value={word} onChangeText={setWord} placeholder="Русские или английские буквы" disabled={busy} word/>
          <Text style={{color:t.muted,fontSize:12,lineHeight:18}}>От 4 до 64 букв, без пробелов. Регистр не важен; «е» и «ё» различаются. Два слова должны отличаться друг от друга, ника и пароля.</Text>
          <SecretInput label="Повтори новое слово" value={confirmation} onChangeText={setConfirmation} placeholder="Введи то же слово вручную" disabled={busy} word onSubmit={()=>void sensitiveChange()}/>
        </>}
        {formError?<Notice text={formError} error/>:null}
        <Button label="Сохранить изменения" icon="checkmark" onPress={()=>void sensitiveChange()} loading={busy}/>
        <Pressable accessibilityRole="button" disabled={busy} onPress={closeForm} style={{minHeight:44,alignItems:'center',justifyContent:'center'}}><Text style={{color:t.muted,fontSize:13}}>Отмена</Text></Pressable>
      </View>
    </Sheet>
    <Sheet visible={action!==null} title={action?.kind==='others'?'Завершить другие сеансы?':'Завершить этот сеанс?'} onClose={()=>{if(!busy)setAction(null);}}>
      <View style={{gap:18,paddingBottom:8}}><Text style={{color:t.muted,fontSize:14,lineHeight:22}}>{action?.kind==='others'?'Этот сеанс останется открытым. На остальных устройствах понадобится снова ввести ник и пароль.':action?.session.isCurrent?'Ты выйдешь из аккаунта на этом устройстве. Переписка останется на сервере.':`На устройстве «${action?.session.deviceName||'Устройство'}» понадобится снова войти с паролем.`}</Text><Button label={action?.kind==='one'&&action.session.isCurrent?'Выйти на этом устройстве':'Завершить'} danger onPress={()=>void revoke()} loading={busy}/></View>
    </Sheet>
  </KeyboardAvoidingView>;
}
