export const QWEN_VOICE_SOURCES = {
  compatibility: "https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides",
  catalog: "https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list",
  custom: "https://help.aliyun.com/zh/model-studio/audio-realtime-voice-cloning-api",
  protocol: "https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events",
} as const;

export interface QwenVoice {
  id: string;
  name: string;
  gender?: string;
  description: string;
  sourceUrl: string;
}

// Live probes show the realtime model accepts only a subset of the TTS Plus/Flash lists: 71 of the
// advertised ids answer `invalid_value / Unsupported voice`, which ends the call. Keep only ids that a
// real qwen-audio-3.1-realtime session.update accepted.
const voices: readonly QwenVoice[] = [
  { id: "longanqian_v3.1", name: "官方默认", description: "3.1 实时模型默认音色；官方未标注性别与风格", sourceUrl: QWEN_VOICE_SOURCES.compatibility },
  { id: "longanlingxin_v3.1", name: "龙安灵心_v3.1", gender: "女", description: "旗舰音色", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xunanchuan_v3.1", name: "许南川", gender: "男", description: "旗舰音色", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanhuan_v3.1", name: "龙安欢_v3.1", gender: "女", description: "旗舰音色", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanfengyue_v3.1", name: "龙安风悦_v3.1", gender: "女", description: "旗舰音色", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "yuxiaoyun_v3.1", name: "于小云", gender: "女", description: "元气、亲切、自然；广告营销、广播、客服助手、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "qiaoxiaojiao_v3.1", name: "乔小娇", gender: "女", description: "俏丽、可爱；广告营销、客服助手、有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xiaxiaochen_v3.1", name: "夏小晨", gender: "女", description: "元气、明亮；广告营销、有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "anmingyuan_v3.1", name: "安明远", gender: "男", description: "清亮、自然；广告营销、有声书、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "wenhuaiqing_v3.1", name: "温怀清", gender: "女", description: "清亮、柔和；儿童故事、客服助手、广告营销、新闻播报", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "anxiaolan_v3.1", name: "安小岚", gender: "女", description: "清甜、纯净；有声书、客服助手、旁白、新闻播报、广告营销", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xieshurou_v3.1", name: "谢舒柔", gender: "女", description: "柔和、自然、知性；有声书、客服助手、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "baiqinglan_v3.1", name: "白清岚", gender: "女", description: "明亮、清纯；语音助手、客服助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xuyuyuan_v3.1", name: "许玉远", gender: "女", description: "知性、成熟、质感；广告营销、新闻播报、旁白、客服助手、有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "anruorou_v3.1", name: "安若柔", gender: "女", description: "气声、知性；旁白、语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "wenhuaizhi_v3.1", name: "闻怀之", gender: "女", description: "稳重、成熟；有声书、新闻播报、广告营销、客服助手、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xiaoxingzhi_v3.1", name: "萧行之", gender: "女", description: "端庄、贵气；新闻播报、有声书、旁白、客服助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "guyunshu_v3.1", name: "顾云舒", gender: "女", description: "成熟、稳重；音乐电台、客服助手、有声书、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "huozhuoshi_v3.1", name: "霍拙石", gender: "男", description: "清亮；有声书、广告营销、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "yeqinghe_v3.1", name: "叶清禾", gender: "女", description: "亲切、温柔；有声书、广告营销、旁白、客服助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "yunhuanhuan_v3.1", name: "云欢欢", gender: "女", description: "高亢、热情；有声书、旁白、客服助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xuxiaoqiao_v3.1", name: "徐小俏", gender: "女", description: "自然、俏皮；有声书、旁白、客服助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "baianran_v3.1", name: "白安然", gender: "女", description: "低沉、浑厚、气声；配音讲解、有声书、旁白", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "xuyanchu_v3.1", name: "许言初", gender: "女", description: "沉稳、磁性；新闻播报、有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "yezhiqing_v3.1", name: "叶知晴", gender: "女", description: "轻快、自然；儿童故事、客服助手、语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "andi_v3.1", name: "安迪", gender: "男", description: "ABC口音；语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "anyuqing_v3.1", name: "安语晴", gender: "女", description: "甜妹；语音助手、旁白、新闻播报", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Emily_v3.1", name: "Emily", gender: "女", description: "英式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Luna_v3.1", name: "Luna", gender: "女", description: "英式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Eric_v3.1", name: "Eric", gender: "男", description: "英式男声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Luca_v3.1", name: "Luca", gender: "男", description: "英式男声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Abby_v3.1", name: "Abby", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Annie_v3.1", name: "Annie", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Ava_v3.1", name: "Ava", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Beth_v3.1", name: "Beth", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Betty_v3.1", name: "Betty", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Cally_v3.1", name: "Cally", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Cindy_v3.1", name: "Cindy", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Donna_v3.1", name: "Donna", gender: "女", description: "美式女声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Andy_v3.1", name: "Andy", gender: "男", description: "美式男声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "Brian_v3.1", name: "Brian", gender: "男", description: "美式男声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "David_v3.1", name: "David", gender: "男", description: "美式男声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanyuanfei_v3.1", name: "龙安元妃_v3.1", gender: "女", description: "高傲妃子音；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longjielidou_v3.1", name: "龙杰力豆_v3.1", gender: "男", description: "天真男童音；儿童陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanlingxi_v3.1", name: "龙安灵希_v3.1", gender: "女", description: "可爱甜美音；社交陪伴（精品中文）", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longhuohuo_v3.1", name: "龙火火_v3.1", gender: "男", description: "顽皮少年音；角色音", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longyingtao_v3.1", name: "龙应桃_v3.1", gender: "女", description: "温柔淡定女；客服", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanya_v3.1", name: "龙安雅_v3.1", gender: "女", description: "高雅气质女；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longwan_v3.1", name: "龙婉_v3.1", gender: "女", description: "细腻柔声女；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longxing_v3.1", name: "龙星_v3.1", gender: "女", description: "温婉邻家女；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longhua_v3.1", name: "龙华_v3.1", gender: "女", description: "元气甜美女；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longhan_v3.1", name: "龙寒_v3.1", gender: "男", description: "温暖痴情男；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanzhi_v3.1", name: "龙安智_v3.1", gender: "男", description: "睿智轻熟男；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longzhe_v3.1", name: "龙哲_v3.1", gender: "男", description: "呆板大暖男；社交陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanyang_v3.1", name: "龙安洋_v3.1", gender: "男", description: "阳光大男孩；社交陪伴（标杆音色）", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "libai_v3.1", name: "李白_v3.1", gender: "男", description: "古代诗仙男；诗词朗诵", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longling_v3.1", name: "龙铃_v3.1", gender: "女", description: "稚气呆板女；童声", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longniuniu_v3.1", name: "龙牛牛_v3.1", gender: "男", description: "阳光男童声；消费电子-儿童有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longshanshan_v3.1", name: "龙闪闪_v3.1", gender: "男", description: "戏剧化童声；消费电子-儿童有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longpaopao_v3.1", name: "龙泡泡_v3.1", gender: "女", description: "飞天泡泡音；消费电子-儿童陪伴", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "loongstella_v3.1", name: "loongstella_v3.1", gender: "女", description: "飒爽利落女；新闻播报", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longyuan_v3.1", name: "龙媛_v3.1", gender: "女", description: "温暖治愈女；有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longmiao_v3.1", name: "龙妙_v3.1", gender: "女", description: "抑扬顿挫女；有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longsanshu_v3.1", name: "龙三叔_v3.1", gender: "男", description: "沉稳质感男；有声书", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanli_v3.1", name: "龙安莉_v3.1", gender: "女", description: "利落从容女；语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanwen_v3.1", name: "龙安温_v3.1", gender: "女", description: "优雅知性女；语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanlang_v3.1", name: "龙安朗_v3.1", gender: "男", description: "清爽利落男；语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longxiaoxia_v3.1", name: "龙小夏_v3.1", gender: "女", description: "沉稳权威女；语音助手", sourceUrl: QWEN_VOICE_SOURCES.catalog },
  { id: "longanchong_v3.1", name: "龙安冲_v3.1", gender: "男", description: "激情推销男；直播带货", sourceUrl: QWEN_VOICE_SOURCES.catalog },
 ];

export function qwenVoicesForModel(model: string): readonly QwenVoice[] {
  return model === "qwen-audio-3.1-realtime-flash" || model === "qwen-audio-3.1-realtime-plus" ? voices : [];
}
