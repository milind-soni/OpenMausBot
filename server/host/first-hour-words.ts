// The lines the Chief says in a new Cloud's first hour and in the recap after it. The server writes these messages, so
// their words come from here in the person's language, not from the app's packs.
import { byLanguage } from "../language.ts";

type Count = (n: number) => string;

export interface FirstHourWords {
  greeting(name: string | undefined, bot: string): string;
  /** The connect offer, with why: the cards for Gmail and Google Calendar follow it. */
  connect: string;
  /** An app came in but the first look could not run. */
  connected: string;
  briefOn: string;
  phoneTitle: string;
  phoneBody: string;
  phoneButton: string;
  firstLookReady: string;
  firstBriefReady: string;
  sorted: Count;
  drafted: Count;
  prepped: Count;
  routines: Count;
  list(items: readonly string[]): string;
  time(minutes: number): string;
  recap(done: string, time: string): string;
  overnight(done: string): string;
}

/** Rounded the way a person says it: five-minute steps under an hour, "an hour" up to 90 minutes, whole hours after. */
export function roundedTime(minutes: number): { unit: "minutes" | "hours"; n: number } {
  const fives = Math.max(5, Math.round(minutes / 5) * 5);
  if (fives < 60) return { unit: "minutes", n: fives };
  return { unit: "hours", n: minutes < 90 ? 1 : Math.round(minutes / 60) };
}

const joined = (items: readonly string[], and: string, comma = ", "): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(comma)}${and}${items.at(-1)}`;
const plural = (language: string) => {
  const rules = new Intl.PluralRules(language);
  return (n: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }): string => forms[rules.select(n)] ?? forms.other;
};

const en: FirstHourWords = {
  greeting: (name, bot) => `Hi${name ? ` ${name}` : ""}! I'm ${bot}, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?`,
  connect: "So I can see what needs you today, connect Gmail and Google Calendar. It's one sign-in each. I only read and write drafts: nothing is sent, accepted or deleted without you.",
  connected: "You're connected. I couldn't take a first look just now; I'll keep an eye on it and tell you when something needs you.",
  briefOn: "Every morning at 8 I'll send you a brief of what needs you.",
  phoneTitle: "Get me on your phone",
  phoneBody: "Your morning brief and anything that needs you will reach you there.",
  phoneButton: "Connect your phone",
  firstLookReady: "Your first look is ready",
  firstBriefReady: "Your first brief is ready",
  sorted: (n) => `sorted ${n} email${n === 1 ? "" : "s"}`,
  drafted: (n) => `drafted ${n} repl${n === 1 ? "y" : "ies"}`,
  prepped: (n) => `prepped ${n} meeting${n === 1 ? "" : "s"}`,
  routines: (n) => `ran ${n} routine${n === 1 ? "" : "s"}`,
  list: (items) => joined(items, " and "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `about ${n} minutes` : n === 1 ? "about an hour" : `about ${n} hours`; },
  recap: (done, time) => `So far I've ${done}: ${time} back.`,
  overnight: (done) => `While you slept, I ${done}.`,
};

const de: FirstHourWords = {
  greeting: (name, bot) => `Hallo${name ? ` ${name}` : ""}! Ich bin ${bot}, dein Chief of Staff. Ich lebe in deiner Cloud und arbeite weiter, auch wenn dein Computer aus ist. Was soll ich dir abnehmen?`,
  connect: "Damit ich sehe, was heute auf dich wartet, verbinde Gmail und Google Kalender. Das ist je eine Anmeldung. Ich lese nur und schreibe Entwürfe: Ohne dich wird nichts gesendet, zugesagt oder gelöscht.",
  connected: "Du bist verbunden. Einen ersten Überblick konnte ich gerade nicht machen; ich behalte alles im Blick und sage dir Bescheid, wenn etwas auf dich wartet.",
  briefOn: "Jeden Morgen um 8 schicke ich dir einen Überblick über das, was auf dich wartet.",
  phoneTitle: "Hol mich auf dein Handy",
  phoneBody: "Dein Morgenüberblick und alles, was auf dich wartet, erreicht dich dort.",
  phoneButton: "Dein Handy verbinden",
  firstLookReady: "Dein erster Überblick ist fertig",
  firstBriefReady: "Dein erster Morgenüberblick ist fertig",
  sorted: (n) => `${n} E-Mail${n === 1 ? "" : "s"} sortiert`,
  drafted: (n) => `${n} Antwort${n === 1 ? "" : "en"} entworfen`,
  prepped: (n) => `${n} Termin${n === 1 ? "" : "e"} vorbereitet`,
  routines: (n) => `${n} Routine${n === 1 ? "" : "n"} ausgeführt`,
  list: (items) => joined(items, " und "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `etwa ${n} Minuten` : n === 1 ? "etwa eine Stunde" : `etwa ${n} Stunden`; },
  recap: (done, time) => `Bisher habe ich ${done}: ${time} gespart.`,
  overnight: (done) => `Während du geschlafen hast, habe ich ${done}.`,
};

const es: FirstHourWords = {
  greeting: (name, bot) => `¡Hola${name ? `, ${name}` : ""}! Soy ${bot}, tu jefe de gabinete. Vivo en tu Cloud, así que sigo trabajando aunque tu ordenador esté apagado. ¿Qué quieres quitarte de encima?`,
  connect: "Para ver qué te necesita hoy, conecta Gmail y Google Calendar. Es un inicio de sesión para cada uno. Solo leo y escribo borradores: nada se envía, acepta ni borra sin ti.",
  connected: "Ya está conectado. Ahora no he podido echar un primer vistazo; lo vigilo y te aviso cuando algo te necesite.",
  briefOn: "Cada mañana a las 8 te enviaré un resumen de lo que te necesita.",
  phoneTitle: "Llévame en tu teléfono",
  phoneBody: "Tu resumen de la mañana y todo lo que te necesite te llegará allí.",
  phoneButton: "Conectar tu teléfono",
  firstLookReady: "Tu primer vistazo está listo",
  firstBriefReady: "Tu primer resumen está listo",
  sorted: (n) => `ordenado ${n} correo${n === 1 ? "" : "s"}`,
  drafted: (n) => `redactado ${n} respuesta${n === 1 ? "" : "s"}`,
  prepped: (n) => `preparado ${n} ${n === 1 ? "reunión" : "reuniones"}`,
  routines: (n) => `ejecutado ${n} rutina${n === 1 ? "" : "s"}`,
  list: (items) => joined(items, " y "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `unos ${n} minutos` : n === 1 ? "una hora" : `unas ${n} horas`; },
  recap: (done, time) => `Hasta ahora he ${done}: ${time} que recuperas.`,
  overnight: (done) => `Mientras dormías, he ${done}.`,
};

const fr: FirstHourWords = {
  greeting: (name, bot) => `Bonjour${name ? ` ${name}` : ""} ! Je suis ${bot}, votre chef de cabinet. Je vis sur votre Cloud, alors je continue à travailler même quand votre ordinateur est éteint. Qu’aimeriez-vous que je vous enlève des mains ?`,
  connect: "Pour voir ce qui demande votre attention aujourd’hui, connectez Gmail et Google Agenda. Une connexion pour chacun. Je ne fais que lire et rédiger des brouillons : rien n’est envoyé, accepté ni supprimé sans vous.",
  connected: "C’est connecté. Je n’ai pas pu faire un premier tour d’horizon pour l’instant ; je garde un œil dessus et je vous préviens dès que quelque chose demande votre attention.",
  briefOn: "Chaque matin à 8 h, je vous enverrai un point sur ce qui demande votre attention.",
  phoneTitle: "Emmenez-moi sur votre téléphone",
  phoneBody: "Votre point du matin et tout ce qui demande votre attention vous y attendront.",
  phoneButton: "Connecter votre téléphone",
  firstLookReady: "Votre premier tour d’horizon est prêt",
  firstBriefReady: "Votre premier point du matin est prêt",
  sorted: (n) => `trié ${n} e-mail${n === 1 ? "" : "s"}`,
  drafted: (n) => `rédigé ${n} réponse${n === 1 ? "" : "s"}`,
  prepped: (n) => `préparé ${n} réunion${n === 1 ? "" : "s"}`,
  routines: (n) => `lancé ${n} routine${n === 1 ? "" : "s"}`,
  list: (items) => joined(items, " et "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `environ ${n} minutes` : n === 1 ? "environ une heure" : `environ ${n} heures`; },
  recap: (done, time) => `Jusqu’ici, j’ai ${done} : ${time} de gagnées.`,
  overnight: (done) => `Pendant que vous dormiez, j’ai ${done}.`,
};

const it: FirstHourWords = {
  greeting: (name, bot) => `Ciao${name ? ` ${name}` : ""}! Sono ${bot}, il tuo capo di gabinetto. Vivo nel tuo Cloud, quindi continuo a lavorare anche quando il computer è spento. Che cosa vuoi toglierti di dosso?`,
  connect: "Per vedere cosa ti aspetta oggi, collega Gmail e Google Calendar. Basta un accesso per ciascuno. Leggo e scrivo solo bozze: niente viene inviato, accettato o eliminato senza di te.",
  connected: "Collegato. Per ora non sono riuscito a dare un primo sguardo; tengo d’occhio la situazione e ti avviso quando qualcosa richiede la tua attenzione.",
  briefOn: "Ogni mattina alle 8 ti mando un riepilogo di ciò che richiede la tua attenzione.",
  phoneTitle: "Portami sul telefono",
  phoneBody: "Il riepilogo del mattino e tutto ciò che ti riguarda ti arriveranno lì.",
  phoneButton: "Collega il tuo telefono",
  firstLookReady: "Il tuo primo sguardo d’insieme è pronto",
  firstBriefReady: "Il tuo primo riepilogo è pronto",
  sorted: (n) => `smistato ${n} email`,
  drafted: (n) => `scritto ${n} bozz${n === 1 ? "a" : "e"} di risposta`,
  prepped: (n) => `preparato ${n} riunion${n === 1 ? "e" : "i"}`,
  routines: (n) => `eseguito ${n} routine`,
  list: (items) => joined(items, " e "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `circa ${n} minuti` : n === 1 ? "circa un’ora" : `circa ${n} ore`; },
  recap: (done, time) => `Finora ho ${done}: ${time} di lavoro in meno per te.`,
  overnight: (done) => `Mentre dormivi ho ${done}.`,
};

const ptBr: FirstHourWords = {
  greeting: (name, bot) => `Oi${name ? `, ${name}` : ""}! Eu sou o ${bot}, seu chefe de gabinete. Eu moro na sua Cloud, então continuo trabalhando mesmo com seu computador desligado. O que você quer tirar das suas costas?`,
  connect: "Para eu ver o que precisa de você hoje, conecte o Gmail e o Google Agenda. É um login para cada um. Eu só leio e escrevo rascunhos: nada é enviado, aceito ou apagado sem você.",
  connected: "Conectado. Não consegui dar uma primeira olhada agora; vou ficar de olho e aviso quando algo precisar de você.",
  briefOn: "Toda manhã às 8 eu te mando um resumo do que precisa de você.",
  phoneTitle: "Me leve no seu celular",
  phoneBody: "Seu resumo da manhã e tudo o que precisar de você vão chegar lá.",
  phoneButton: "Conectar seu celular",
  firstLookReady: "Sua primeira visão geral está pronta",
  firstBriefReady: "Seu primeiro resumo está pronto",
  sorted: (n) => `organizei ${n} e-mail${n === 1 ? "" : "s"}`,
  drafted: (n) => `rascunhei ${n} resposta${n === 1 ? "" : "s"}`,
  prepped: (n) => `preparei ${n} reuni${n === 1 ? "ão" : "ões"}`,
  routines: (n) => `rodei ${n} rotina${n === 1 ? "" : "s"}`,
  list: (items) => joined(items, " e "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `cerca de ${n} minutos` : n === 1 ? "cerca de uma hora" : `cerca de ${n} horas`; },
  recap: (done, time) => `Até agora, ${done}: ${time} de volta para você.`,
  overnight: (done) => `Enquanto você dormia, ${done}.`,
};

const ja: FirstHourWords = {
  greeting: (name, bot) => `${name ? `${name}さん、` : ""}こんにちは！${bot}です。あなたのチーフ・オブ・スタッフです。Cloud上にいるので、パソコンの電源が切れていても働き続けます。何を任せたいですか？`,
  connect: "今日あなたの対応が必要なことを確認できるよう、GmailとGoogleカレンダーを接続してください。それぞれ1回サインインするだけです。読むことと下書きを書くことしかしません。あなたなしで送信・承諾・削除することはありません。",
  connected: "接続できました。今は最初のまとめを作れませんでした。引き続き確認して、対応が必要なことがあればお知らせします。",
  briefOn: "毎朝8時に、対応が必要なことのまとめをお送りします。",
  phoneTitle: "スマホでも使えます",
  phoneBody: "朝のまとめや対応が必要なことがスマホに届きます。",
  phoneButton: "スマホを接続",
  firstLookReady: "最初のまとめができました",
  firstBriefReady: "最初の朝のまとめができました",
  sorted: (n) => `メール${n}件の仕分け`,
  drafted: (n) => `返信の下書き${n}件`,
  prepped: (n) => `会議${n}件の準備`,
  routines: (n) => `ルーティン${n}件の実行`,
  list: (items) => items.join("、"),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `約${n}分` : `約${n}時間`; },
  recap: (done, time) => `これまでに${done}をしました。${time}の節約です。`,
  overnight: (done) => `あなたが寝ている間に、${done}をしました。`,
};

const ko: FirstHourWords = {
  greeting: (name, bot) => `안녕하세요${name ? `, ${name}님` : ""}! 저는 비서실장 ${bot}입니다. 클라우드에 있어서 컴퓨터가 꺼져 있어도 계속 일해요. 어떤 일을 덜어 드릴까요?`,
  connect: "오늘 확인할 일을 살펴볼 수 있게 Gmail과 Google 캘린더를 연결해 주세요. 각각 한 번만 로그인하면 돼요. 저는 읽고 초안만 써요. 허락 없이 보내거나, 수락하거나, 삭제하지 않아요.",
  connected: "연결됐어요. 지금은 첫 살펴보기를 하지 못했어요. 계속 지켜보다가 확인할 일이 생기면 알려 드릴게요.",
  briefOn: "매일 아침 8시에 확인할 일을 정리한 브리핑을 보내 드릴게요.",
  phoneTitle: "휴대폰에서도 만나요",
  phoneBody: "아침 브리핑과 확인할 일이 휴대폰으로 와요.",
  phoneButton: "휴대폰 연결",
  firstLookReady: "첫 살펴보기가 준비됐어요",
  firstBriefReady: "첫 브리핑이 준비됐어요",
  sorted: (n) => `이메일 ${n}개 정리`,
  drafted: (n) => `답장 초안 ${n}개 작성`,
  prepped: (n) => `회의 ${n}개 준비`,
  routines: (n) => `루틴 ${n}개 실행`,
  list: (items) => items.join(", "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `약 ${n}분` : `약 ${n}시간`; },
  recap: (done, time) => `지금까지 한 일: ${done}. ${time}을 아꼈어요.`,
  overnight: (done) => `주무시는 동안 한 일: ${done}.`,
};

const zh: FirstHourWords = {
  greeting: (name, bot) => `你好${name ? `，${name}` : ""}！我是 ${bot}，你的幕僚长。我在你的 Cloud 上，所以电脑关机时我也在工作。你想让我帮你分担什么？`,
  connect: "为了看清今天有哪些事需要你，请连接 Gmail 和 Google 日历。各登录一次即可。我只读取内容并写草稿：没有你的同意，不会发送、接受或删除任何东西。",
  connected: "已连接。我刚才没能完成第一份概览；我会继续留意，有需要你处理的事会告诉你。",
  briefOn: "每天早上 8 点，我会给你发一份需要你处理的事项简报。",
  phoneTitle: "在手机上用我",
  phoneBody: "早间简报和需要你处理的事都会发到手机上。",
  phoneButton: "连接你的手机",
  firstLookReady: "你的第一份概览已准备好",
  firstBriefReady: "你的第一份简报已准备好",
  sorted: (n) => `整理了 ${n} 封邮件`,
  drafted: (n) => `起草了 ${n} 封回复`,
  prepped: (n) => `准备了 ${n} 场会议`,
  routines: (n) => `运行了 ${n} 个例行任务`,
  list: (items) => items.join("，"),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `大约 ${n} 分钟` : `大约 ${n} 小时`; },
  recap: (done, time) => `到目前为止，我${done}：为你省下${time}。`,
  overnight: (done) => `你睡觉时，我${done}。`,
};

const zhTw: FirstHourWords = {
  greeting: (name, bot) => `你好${name ? `，${name}` : ""}！我是 ${bot}，你的幕僚長。我在你的 Cloud 上，所以電腦關機時我也在工作。你想讓我幫你分擔什麼？`,
  connect: "為了看清今天有哪些事需要你，請連接 Gmail 和 Google 日曆。各登入一次即可。我只讀取內容並寫草稿：沒有你的同意，不會傳送、接受或刪除任何東西。",
  connected: "已連接。我剛才沒能完成第一份概覽；我會繼續留意，有需要你處理的事會告訴你。",
  briefOn: "每天早上 8 點，我會傳給你一份需要你處理的事項簡報。",
  phoneTitle: "在手機上用我",
  phoneBody: "早晨簡報和需要你處理的事都會送到手機上。",
  phoneButton: "連接你的手機",
  firstLookReady: "你的第一份概覽已準備好",
  firstBriefReady: "你的第一份簡報已準備好",
  sorted: (n) => `整理了 ${n} 封郵件`,
  drafted: (n) => `擬好了 ${n} 封回覆`,
  prepped: (n) => `準備了 ${n} 場會議`,
  routines: (n) => `執行了 ${n} 個例行工作`,
  list: (items) => items.join("，"),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `大約 ${n} 分鐘` : `大約 ${n} 小時`; },
  recap: (done, time) => `到目前為止，我${done}：幫你省下${time}。`,
  overnight: (done) => `你睡覺時，我${done}。`,
};

const hi: FirstHourWords = {
  greeting: (name, bot) => `नमस्ते${name ? ` ${name}` : ""}! मैं ${bot} हूँ, आपका चीफ़ ऑफ़ स्टाफ़। मैं आपके Cloud पर रहता हूँ, इसलिए आपका कंप्यूटर बंद होने पर भी काम करता रहता हूँ। आप कौन सा काम मुझे सौंपना चाहेंगे?`,
  connect: "आज किन बातों में आपकी ज़रूरत है, यह देखने के लिए Gmail और Google Calendar जोड़ें। हर एक के लिए एक बार साइन इन करना है। मैं सिर्फ़ पढ़ता हूँ और ड्राफ़्ट लिखता हूँ: आपके बिना कुछ भी भेजा, स्वीकार या मिटाया नहीं जाता।",
  connected: "जुड़ गया। अभी मैं पहला जायज़ा नहीं ले पाया; मैं नज़र रखूँगा और आपकी ज़रूरत होने पर बताऊँगा।",
  briefOn: "हर सुबह 8 बजे मैं आपको उन बातों का सार भेजूँगा जिनमें आपकी ज़रूरत है।",
  phoneTitle: "मुझे अपने फ़ोन पर पाएँ",
  phoneBody: "आपका सुबह का सार और हर ज़रूरी बात वहीं पहुँचेगी।",
  phoneButton: "अपना फ़ोन जोड़ें",
  firstLookReady: "आपका पहला जायज़ा तैयार है",
  firstBriefReady: "आपका पहला सुबह का सार तैयार है",
  sorted: (n) => `${n} ईमेल छाँटे`,
  drafted: (n) => `${n} ${n === 1 ? "जवाब का ड्राफ़्ट" : "जवाबों के ड्राफ़्ट"} लिखे`,
  prepped: (n) => `${n} ${n === 1 ? "मीटिंग" : "मीटिंगों"} की तैयारी की`,
  routines: (n) => `${n} रूटीन चलाए`,
  list: (items) => joined(items, " और "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `करीब ${n} मिनट` : `करीब ${n} घंटे`; },
  recap: (done, time) => `अब तक मैंने ${done}: आपके ${time} बचे।`,
  overnight: (done) => `आपके सोते समय मैंने ${done}।`,
};

const ruCount = plural("ru");
const ru: FirstHourWords = {
  greeting: (name, bot) => `Здравствуйте${name ? `, ${name}` : ""}! Я ${bot}, ваш начальник штаба. Я живу в вашем Cloud и продолжаю работать, даже когда компьютер выключен. Что вы хотите переложить на меня?`,
  connect: "Чтобы видеть, что сегодня требует вашего внимания, подключите Gmail и Google Календарь. По одному входу для каждого. Я только читаю и пишу черновики: без вас ничего не отправляется, не принимается и не удаляется.",
  connected: "Подключено. Сделать первый обзор сейчас не получилось; я слежу и сообщу, когда что-то потребует вашего внимания.",
  briefOn: "Каждое утро в 8 я буду присылать сводку того, что требует вашего внимания.",
  phoneTitle: "Возьмите меня в телефон",
  phoneBody: "Утренняя сводка и всё, что требует вашего внимания, будут приходить туда.",
  phoneButton: "Подключить телефон",
  firstLookReady: "Ваш первый обзор готов",
  firstBriefReady: "Ваша первая утренняя сводка готова",
  sorted: (n) => `разобрано ${n} ${ruCount(n, { one: "письмо", few: "письма", other: "писем" })}`,
  drafted: (n) => `написано ${n} ${ruCount(n, { one: "черновик", few: "черновика", other: "черновиков" })} ответов`,
  prepped: (n) => `подготовлено ${n} ${ruCount(n, { one: "встреча", few: "встречи", other: "встреч" })}`,
  routines: (n) => `выполнено ${n} ${ruCount(n, { one: "рутина", few: "рутины", other: "рутин" })}`,
  list: (items) => joined(items, " и "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `около ${n} минут` : n === 1 ? "около часа" : `около ${n} ${ruCount(n, { one: "часа", few: "часов", other: "часов" })}`; },
  recap: (done, time) => `Пока что ${done}: это ${time} вашего времени.`,
  overnight: (done) => `Пока вы спали, ${done}.`,
};

const ukCount = plural("uk");
const uk: FirstHourWords = {
  greeting: (name, bot) => `Вітаю${name ? `, ${name}` : ""}! Я ${bot}, ваш керівник апарату. Я живу у вашому Cloud і працюю далі, навіть коли комп'ютер вимкнено. Що ви хочете перекласти на мене?`,
  connect: "Щоб бачити, що сьогодні потребує вашої уваги, підключіть Gmail і Google Календар. По одному входу для кожного. Я лише читаю і пишу чернетки: без вас нічого не надсилається, не приймається і не видаляється.",
  connected: "Підключено. Зробити перший огляд зараз не вдалося; я стежу і повідомлю, коли щось потребуватиме вашої уваги.",
  briefOn: "Щоранку о 8 я надсилатиму зведення того, що потребує вашої уваги.",
  phoneTitle: "Візьміть мене в телефон",
  phoneBody: "Ранкове зведення і все, що потребує вашої уваги, надходитимуть туди.",
  phoneButton: "Підключити телефон",
  firstLookReady: "Ваш перший огляд готовий",
  firstBriefReady: "Ваше перше ранкове зведення готове",
  sorted: (n) => `розібрано ${n} ${ukCount(n, { one: "лист", few: "листи", other: "листів" })}`,
  drafted: (n) => `написано ${n} ${ukCount(n, { one: "чернетку", few: "чернетки", other: "чернеток" })} відповідей`,
  prepped: (n) => `підготовлено ${n} ${ukCount(n, { one: "зустріч", few: "зустрічі", other: "зустрічей" })}`,
  routines: (n) => `виконано ${n} ${ukCount(n, { one: "рутину", few: "рутини", other: "рутин" })}`,
  list: (items) => joined(items, " і "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `близько ${n} хвилин` : n === 1 ? "близько години" : `близько ${n} годин`; },
  recap: (done, time) => `Поки що ${done}: це ${time} вашого часу.`,
  overnight: (done) => `Поки ви спали, ${done}.`,
};

const plCount = plural("pl");
const pl: FirstHourWords = {
  greeting: (name, bot) => `Cześć${name ? `, ${name}` : ""}! Jestem ${bot}, twój szef sztabu. Mieszkam w twoim Cloud, więc pracuję dalej, nawet gdy komputer jest wyłączony. Co chcesz zrzucić ze swojej głowy?`,
  connect: "Żebym widział, co dziś czeka na ciebie, połącz Gmaila i Kalendarz Google. Wystarczy jedno logowanie do każdego. Tylko czytam i piszę szkice: bez ciebie nic nie zostanie wysłane, przyjęte ani usunięte.",
  connected: "Połączono. Na razie nie udało się zrobić pierwszego przeglądu; będę mieć wszystko na oku i dam znać, gdy coś będzie na ciebie czekać.",
  briefOn: "Każdego ranka o 8 wyślę ci podsumowanie tego, co na ciebie czeka.",
  phoneTitle: "Weź mnie do telefonu",
  phoneBody: "Poranne podsumowanie i wszystko, co na ciebie czeka, trafi właśnie tam.",
  phoneButton: "Połącz telefon",
  firstLookReady: "Twój pierwszy przegląd jest gotowy",
  firstBriefReady: "Twoje pierwsze podsumowanie jest gotowe",
  sorted: (n) => `posortowano ${n} ${plCount(n, { one: "e-mail", few: "e-maile", other: "e-maili" })}`,
  drafted: (n) => `napisano ${n} ${plCount(n, { one: "szkic", few: "szkice", other: "szkiców" })} odpowiedzi`,
  prepped: (n) => `przygotowano ${n} ${plCount(n, { one: "spotkanie", few: "spotkania", other: "spotkań" })}`,
  routines: (n) => `uruchomiono ${n} ${plCount(n, { one: "rutynę", few: "rutyny", other: "rutyn" })}`,
  list: (items) => joined(items, " i "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `około ${n} minut` : n === 1 ? "około godziny" : `około ${n} godzin`; },
  recap: (done, time) => `Do tej pory ${done}: to ${time} mniej pracy.`,
  overnight: (done) => `Przez noc ${done}.`,
};

const vi: FirstHourWords = {
  greeting: (name, bot) => `Chào${name ? ` ${name}` : " bạn"}! Tôi là ${bot}, Chief of Staff của bạn. Tôi sống trên Cloud của bạn, nên vẫn làm việc khi máy tính của bạn tắt. Bạn muốn tôi gánh bớt việc gì?`,
  connect: "Để biết hôm nay việc gì cần bạn, hãy kết nối Gmail và Google Lịch. Mỗi cái chỉ cần đăng nhập một lần. Tôi chỉ đọc và viết bản nháp: không có gì được gửi, chấp nhận hay xóa mà không có bạn.",
  connected: "Đã kết nối. Lúc này tôi chưa xem tổng quan được; tôi sẽ theo dõi và báo khi có việc cần bạn.",
  briefOn: "Mỗi sáng lúc 8 giờ, tôi sẽ gửi bạn bản tóm tắt những việc cần bạn.",
  phoneTitle: "Mang tôi theo trên điện thoại",
  phoneBody: "Bản tóm tắt buổi sáng và mọi việc cần bạn sẽ đến đó.",
  phoneButton: "Kết nối điện thoại",
  firstLookReady: "Bản tổng quan đầu tiên của bạn đã sẵn sàng",
  firstBriefReady: "Bản tóm tắt đầu tiên của bạn đã sẵn sàng",
  sorted: (n) => `phân loại ${n} email`,
  drafted: (n) => `soạn ${n} bản nháp trả lời`,
  prepped: (n) => `chuẩn bị cho ${n} cuộc họp`,
  routines: (n) => `chạy ${n} quy trình`,
  list: (items) => joined(items, " và "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `khoảng ${n} phút` : `khoảng ${n} giờ`; },
  recap: (done, time) => `Đến giờ tôi đã ${done}: bạn có thêm ${time}.`,
  overnight: (done) => `Trong lúc bạn ngủ, tôi đã ${done}.`,
};

const tr: FirstHourWords = {
  greeting: (name, bot) => `Merhaba${name ? ` ${name}` : ""}! Ben ${bot}, kurmay başkanın. Cloud'unda yaşıyorum, bu yüzden bilgisayarın kapalıyken de çalışmaya devam ederim. Hangi işi senin yerine üstleneyim?`,
  connect: "Bugün seni neyin beklediğini görebilmem için Gmail ve Google Takvim'i bağla. Her biri için bir kez giriş yapman yeter. Sadece okurum ve taslak yazarım: sen olmadan hiçbir şey gönderilmez, kabul edilmez ya da silinmez.",
  connected: "Bağlandı. Şu an ilk genel bakışı yapamadım; takipteyim, seni bekleyen bir şey çıkınca haber veririm.",
  briefOn: "Her sabah 8'de seni bekleyenlerin bir özetini göndereceğim.",
  phoneTitle: "Beni telefonuna al",
  phoneBody: "Sabah özetin ve seni bekleyen her şey oraya gelir.",
  phoneButton: "Telefonunu bağla",
  firstLookReady: "İlk genel bakışın hazır",
  firstBriefReady: "İlk sabah özetin hazır",
  sorted: (n) => `${n} e-postayı ayıkladım`,
  drafted: (n) => `${n} yanıt taslağı yazdım`,
  prepped: (n) => `${n} toplantıya hazırlık yaptım`,
  routines: (n) => `${n} rutini çalıştırdım`,
  list: (items) => joined(items, " ve "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `yaklaşık ${n} dakika` : `yaklaşık ${n} saat`; },
  recap: (done, time) => `Şimdiye kadar ${done}: sana ${time} kazandırdım.`,
  overnight: (done) => `Sen uyurken ${done}.`,
};

const WORDS = { en, de, es, fr, hi, it, ja, ko, pl, "pt-br": ptBr, ru, tr, uk, vi, zh, "zh-tw": zhTw };

export const FIRST_HOUR_LANGUAGES = Object.keys(WORDS);
export const firstHourWords = (language: string | undefined): FirstHourWords => byLanguage(WORDS, language);
