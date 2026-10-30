// The morning brief's own words: the greeting, what the bots found and finished overnight, how long a question has
// waited and the morning time, in the language set in Settings rather than from the app's packs.
import { byLanguage } from "../language.ts";

type Count = (count: number) => string;
type Name = (name: string) => string;

export interface MorningWords {
  greeting: { morning: string; afternoon: string; evening: string };
  /** How a sentence ends, what follows it, and how a list is joined, so the greeting line reads naturally. */
  stop: string;
  gap: string;
  comma: string;
  done: Count;
  doneTitle: string;
  doneSince: Name;
  youAsked: string;
  botAsked: string;
  onItsOwn: string;
  waiting: { today: Name; yesterday: Name; earlier: Name };
  notNow: string;
  found: Count;
  foundTitle: string;
  gotIt: string;
  answered: (bot: string, answer: string) => string;
  morningAt: Name;
  morningOff: string;
  changeTime: string;
  turnOff: string;
  turnOn: string;
  cancel: string;
}

const en: MorningWords = {
  greeting: { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => `${n} done overnight`,
  doneTitle: "Done overnight",
  doneSince: (clock) => `Since ${clock}`,
  youAsked: "You asked",
  botAsked: "Another bot asked",
  onItsOwn: "Started on its own",
  waiting: { today: (clock) => `Waiting since ${clock}`, yesterday: (clock) => `Waiting since yesterday ${clock}`, earlier: (date) => `Waiting since ${date}` },
  notNow: "Not now",
  found: (n) => `${n} found for you`,
  foundTitle: "Found for you",
  gotIt: "Got it",
  answered: (bot, answer) => `Answered ${bot}: ${answer}`,
  morningAt: (clock) => `Morning brief at ${clock}`,
  morningOff: "Morning brief is off",
  changeTime: "Change time",
  turnOff: "Turn off",
  turnOn: "Turn on",
  cancel: "Cancel",
};

const ptBr: MorningWords = {
  greeting: { morning: "Bom dia", afternoon: "Boa tarde", evening: "Boa noite" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => (n === 1 ? `${n} tarefa feita durante a noite` : `${n} tarefas feitas durante a noite`),
  doneTitle: "Feito durante a noite",
  doneSince: (clock) => `Desde ${clock}`,
  youAsked: "Você pediu",
  botAsked: "Outro bot pediu",
  onItsOwn: "Começou por conta própria",
  waiting: { today: (clock) => `Aguardando desde ${clock}`, yesterday: (clock) => `Aguardando desde ontem, ${clock}`, earlier: (date) => `Aguardando desde ${date}` },
  notNow: "Agora não",
  found: (n) => (n === 1 ? `${n} novidade para você` : `${n} novidades para você`),
  foundTitle: "Encontrado para você",
  gotIt: "Entendi",
  answered: (bot, answer) => `Respondido para ${bot}: ${answer}`,
  morningAt: (clock) => `Resumo da manhã às ${clock}`,
  morningOff: "O resumo da manhã está desligado",
  changeTime: "Mudar horário",
  turnOff: "Desligar",
  turnOn: "Ligar",
  cancel: "Cancelar",
};

const es: MorningWords = {
  greeting: { morning: "Buenos días", afternoon: "Buenas tardes", evening: "Buenas noches" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => (n === 1 ? `${n} tarea hecha durante la noche` : `${n} tareas hechas durante la noche`),
  doneTitle: "Hecho durante la noche",
  doneSince: (clock) => `Desde las ${clock}`,
  youAsked: "Lo pediste tú",
  botAsked: "Lo pidió otro bot",
  onItsOwn: "Empezó por su cuenta",
  waiting: { today: (clock) => `Esperando desde las ${clock}`, yesterday: (clock) => `Esperando desde ayer a las ${clock}`, earlier: (date) => `Esperando desde el ${date}` },
  notNow: "Ahora no",
  found: (n) => (n === 1 ? `${n} hallazgo para ti` : `${n} hallazgos para ti`),
  foundTitle: "Encontrado para ti",
  gotIt: "Entendido",
  answered: (bot, answer) => `Respondiste a ${bot}: ${answer}`,
  morningAt: (clock) => `Resumen de la mañana a las ${clock}`,
  morningOff: "El resumen de la mañana está desactivado",
  changeTime: "Cambiar hora",
  turnOff: "Desactivar",
  turnOn: "Activar",
  cancel: "Cancelar",
};

const de: MorningWords = {
  greeting: { morning: "Guten Morgen", afternoon: "Guten Tag", evening: "Guten Abend" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => `${n} über Nacht erledigt`,
  doneTitle: "Über Nacht erledigt",
  doneSince: (clock) => `Seit ${clock}`,
  youAsked: "Auf deine Bitte",
  botAsked: "Auf Bitte eines anderen Bots",
  onItsOwn: "Von selbst gestartet",
  waiting: { today: (clock) => `Wartet seit ${clock}`, yesterday: (clock) => `Wartet seit gestern ${clock}`, earlier: (date) => `Wartet seit ${date}` },
  notNow: "Nicht jetzt",
  found: (n) => `${n} für dich gefunden`,
  foundTitle: "Für dich gefunden",
  gotIt: "Verstanden",
  answered: (bot, answer) => `${bot} geantwortet: ${answer}`,
  morningAt: (clock) => `Morgenüberblick um ${clock}`,
  morningOff: "Der Morgenüberblick ist aus",
  changeTime: "Uhrzeit ändern",
  turnOff: "Ausschalten",
  turnOn: "Einschalten",
  cancel: "Abbrechen",
};

const fr: MorningWords = {
  greeting: { morning: "Bonjour", afternoon: "Bon après-midi", evening: "Bonsoir" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => (n === 1 ? `${n} tâche faite cette nuit` : `${n} tâches faites cette nuit`),
  doneTitle: "Fait cette nuit",
  doneSince: (clock) => `Depuis ${clock}`,
  youAsked: "À votre demande",
  botAsked: "À la demande d'un autre bot",
  onItsOwn: "Lancé tout seul",
  waiting: { today: (clock) => `En attente depuis ${clock}`, yesterday: (clock) => `En attente depuis hier ${clock}`, earlier: (date) => `En attente depuis le ${date}` },
  notNow: "Pas maintenant",
  found: (n) => (n === 1 ? `${n} trouvaille pour vous` : `${n} trouvailles pour vous`),
  foundTitle: "Trouvé pour vous",
  gotIt: "Compris",
  answered: (bot, answer) => `Réponse à ${bot} : ${answer}`,
  morningAt: (clock) => `Point du matin à ${clock}`,
  morningOff: "Le point du matin est désactivé",
  changeTime: "Changer l'heure",
  turnOff: "Désactiver",
  turnOn: "Activer",
  cancel: "Annuler",
};

const ja: MorningWords = {
  greeting: { morning: "おはようございます", afternoon: "こんにちは", evening: "こんばんは" },
  stop: "。", gap: "", comma: "、",
  done: (n) => `夜のうちに${n}件完了`,
  doneTitle: "夜のうちに完了",
  doneSince: (clock) => `${clock}以降`,
  youAsked: "あなたの依頼",
  botAsked: "別のボットの依頼",
  onItsOwn: "自動で開始",
  waiting: { today: (clock) => `${clock}から待機中`, yesterday: (clock) => `昨日${clock}から待機中`, earlier: (date) => `${date}から待機中` },
  notNow: "あとで",
  found: (n) => `あなた向けの発見${n}件`,
  foundTitle: "あなた向けの発見",
  gotIt: "了解",
  answered: (bot, answer) => `${bot}に回答: ${answer}`,
  morningAt: (clock) => `朝のブリーフィング: ${clock}`,
  morningOff: "朝のブリーフィングはオフです",
  changeTime: "時刻を変更",
  turnOff: "オフにする",
  turnOn: "オンにする",
  cancel: "キャンセル",
};

const zh: MorningWords = {
  greeting: { morning: "早上好", afternoon: "下午好", evening: "晚上好" },
  stop: "。", gap: "", comma: "，",
  done: (n) => `夜间完成 ${n} 项`,
  doneTitle: "夜间完成",
  doneSince: (clock) => `自 ${clock} 起`,
  youAsked: "你的请求",
  botAsked: "另一个机器人的请求",
  onItsOwn: "自动开始",
  waiting: { today: (clock) => `从 ${clock} 起等待`, yesterday: (clock) => `从昨天 ${clock} 起等待`, earlier: (date) => `从 ${date} 起等待` },
  notNow: "稍后",
  found: (n) => `为你发现 ${n} 项`,
  foundTitle: "为你发现",
  gotIt: "知道了",
  answered: (bot, answer) => `已回答 ${bot}：${answer}`,
  morningAt: (clock) => `晨间简报时间：${clock}`,
  morningOff: "晨间简报已关闭",
  changeTime: "更改时间",
  turnOff: "关闭",
  turnOn: "开启",
  cancel: "取消",
};

const zhTw: MorningWords = {
  greeting: { morning: "早安", afternoon: "午安", evening: "晚安" },
  stop: "。", gap: "", comma: "，",
  done: (n) => `夜間完成 ${n} 項`,
  doneTitle: "夜間完成",
  doneSince: (clock) => `自 ${clock} 起`,
  youAsked: "你的請求",
  botAsked: "另一個機器人的請求",
  onItsOwn: "自動開始",
  waiting: { today: (clock) => `從 ${clock} 起等待`, yesterday: (clock) => `從昨天 ${clock} 起等待`, earlier: (date) => `從 ${date} 起等待` },
  notNow: "稍後",
  found: (n) => `為你發現 ${n} 項`,
  foundTitle: "為你發現",
  gotIt: "知道了",
  answered: (bot, answer) => `已回答 ${bot}：${answer}`,
  morningAt: (clock) => `晨間簡報時間：${clock}`,
  morningOff: "晨間簡報已關閉",
  changeTime: "更改時間",
  turnOff: "關閉",
  turnOn: "開啟",
  cancel: "取消",
};

const hi: MorningWords = {
  greeting: { morning: "सुप्रभात", afternoon: "नमस्ते", evening: "शुभ संध्या" },
  stop: "।", gap: " ", comma: ", ",
  done: (n) => `रात में ${n} काम पूरे हुए`,
  doneTitle: "रात में पूरे हुए काम",
  doneSince: (clock) => `${clock} से`,
  youAsked: "आपने कहा था",
  botAsked: "दूसरे बॉट ने कहा था",
  onItsOwn: "अपने-आप शुरू हुआ",
  waiting: { today: (clock) => `${clock} से इंतज़ार में`, yesterday: (clock) => `कल ${clock} से इंतज़ार में`, earlier: (date) => `${date} से इंतज़ार में` },
  notNow: "अभी नहीं",
  found: (n) => `आपके लिए ${n} नई जानकारी`,
  foundTitle: "आपके लिए मिली जानकारी",
  gotIt: "ठीक है",
  answered: (bot, answer) => `${bot} को जवाब दिया: ${answer}`,
  morningAt: (clock) => `सुबह का सारांश ${clock} बजे`,
  morningOff: "सुबह का सारांश बंद है",
  changeTime: "समय बदलें",
  turnOff: "बंद करें",
  turnOn: "चालू करें",
  cancel: "रद्द करें",
};

const uk: MorningWords = {
  greeting: { morning: "Доброго ранку", afternoon: "Добрий день", evening: "Добрий вечір" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => `${n} зроблено за ніч`,
  doneTitle: "Зроблено за ніч",
  doneSince: (clock) => `Від ${clock}`,
  youAsked: "На ваше прохання",
  botAsked: "На прохання іншого бота",
  onItsOwn: "Розпочато самостійно",
  waiting: { today: (clock) => `Чекає з ${clock}`, yesterday: (clock) => `Чекає з учора, ${clock}`, earlier: (date) => `Чекає з ${date}` },
  notNow: "Не зараз",
  found: (n) => `${n} знайдено для вас`,
  foundTitle: "Знайдено для вас",
  gotIt: "Зрозуміло",
  answered: (bot, answer) => `Відповідь для ${bot}: ${answer}`,
  morningAt: (clock) => `Ранковий огляд о ${clock}`,
  morningOff: "Ранковий огляд вимкнено",
  changeTime: "Змінити час",
  turnOff: "Вимкнути",
  turnOn: "Увімкнути",
  cancel: "Скасувати",
};

const vi: MorningWords = {
  greeting: { morning: "Chào buổi sáng", afternoon: "Chào buổi chiều", evening: "Chào buổi tối" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => `${n} việc đã xong trong đêm`,
  doneTitle: "Đã xong trong đêm",
  doneSince: (clock) => `Từ ${clock}`,
  youAsked: "Bạn đã nhờ",
  botAsked: "Bot khác đã nhờ",
  onItsOwn: "Tự bắt đầu",
  waiting: { today: (clock) => `Đang chờ từ ${clock}`, yesterday: (clock) => `Đang chờ từ hôm qua lúc ${clock}`, earlier: (date) => `Đang chờ từ ${date}` },
  notNow: "Để sau",
  found: (n) => `${n} điều tìm thấy cho bạn`,
  foundTitle: "Tìm thấy cho bạn",
  gotIt: "Đã hiểu",
  answered: (bot, answer) => `Đã trả lời ${bot}: ${answer}`,
  morningAt: (clock) => `Bản tóm tắt buổi sáng lúc ${clock}`,
  morningOff: "Bản tóm tắt buổi sáng đang tắt",
  changeTime: "Đổi giờ",
  turnOff: "Tắt",
  turnOn: "Bật",
  cancel: "Hủy",
};

const tr: MorningWords = {
  greeting: { morning: "Günaydın", afternoon: "İyi günler", evening: "İyi akşamlar" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => `gece ${n} iş tamamlandı`,
  doneTitle: "Gece tamamlananlar",
  doneSince: (clock) => `${clock} itibarıyla`,
  youAsked: "Senin isteğin",
  botAsked: "Başka bir botun isteği",
  onItsOwn: "Kendiliğinden başladı",
  waiting: { today: (clock) => `${clock} saatinden beri bekliyor`, yesterday: (clock) => `Dün ${clock} saatinden beri bekliyor`, earlier: (date) => `${date} tarihinden beri bekliyor` },
  notNow: "Şimdi değil",
  found: (n) => `senin için ${n} bulgu`,
  foundTitle: "Senin için bulunanlar",
  gotIt: "Anladım",
  answered: (bot, answer) => `${bot} yanıtlandı: ${answer}`,
  morningAt: (clock) => `Sabah özeti saat ${clock}`,
  morningOff: "Sabah özeti kapalı",
  changeTime: "Saati değiştir",
  turnOff: "Kapat",
  turnOn: "Aç",
  cancel: "İptal",
};

const ko: MorningWords = {
  greeting: { morning: "좋은 아침이에요", afternoon: "좋은 오후예요", evening: "좋은 저녁이에요" },
  stop: ".", gap: " ", comma: ", ",
  done: (n) => `밤사이 ${n}건 완료`,
  doneTitle: "밤사이 완료",
  doneSince: (clock) => `${clock} 이후`,
  youAsked: "직접 요청",
  botAsked: "다른 봇의 요청",
  onItsOwn: "자동으로 시작",
  waiting: { today: (clock) => `${clock}부터 대기 중`, yesterday: (clock) => `어제 ${clock}부터 대기 중`, earlier: (date) => `${date}부터 대기 중` },
  notNow: "나중에",
  found: (n) => `발견한 소식 ${n}건`,
  foundTitle: "발견한 소식",
  gotIt: "확인",
  answered: (bot, answer) => `${bot}에 답함: ${answer}`,
  morningAt: (clock) => `아침 브리핑 ${clock}`,
  morningOff: "아침 브리핑이 꺼져 있어요",
  changeTime: "시간 변경",
  turnOff: "끄기",
  turnOn: "켜기",
  cancel: "취소",
};

const WORDS = { en, de, es, fr, hi, ja, ko, "pt-br": ptBr, zh, "zh-tw": zhTw, uk, vi, tr };

export const ENGLISH_MORNING: MorningWords = en;
export const morningWords = (language: string | undefined): MorningWords => byLanguage(WORDS, language);
