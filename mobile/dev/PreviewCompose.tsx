import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, palette } from '../src/theme';
import { Api } from '../src/api';
import { NewMessageSheet } from '../src/NewMessageSheet';
const names = [['Алина Смирнова','alina'],['Артём','artem_k'],['Борис','boris'],['Вика','vika.m'],['Глеб Орлов','gleb'],['Даша','dasha'],['Денис','den4ik'],['Егор','egor'],['Женя','zhenya'],['Кирилл','kirill']];
const users = names.map(([displayName, username], i) => ({ id: 'u' + i, displayName, username, avatarId: null } as any));
class FakeApi extends Api { contacts = async () => ({ users }); users = async () => ({ users: [] }); }
export default function Preview() {
  const api = new FakeApi('https://example.invalid', 'token');
  return <SafeAreaProvider><ThemeContext.Provider value={palette.dark}><NewMessageSheet api={api} visible onClose={() => {}} onOpen={() => {}} onFindPeople={() => {}} /></ThemeContext.Provider></SafeAreaProvider>;
}
