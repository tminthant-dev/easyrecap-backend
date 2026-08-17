import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import rabbit from 'rabbit-node';

// ၁။ မူလ Unicode .srt ဖိုင်ကို ဖတ်မည်
const uniSub = fs.readFileSync('test-sub.srt', 'utf8');

// ၂။ FFmpeg တွင် စာလုံးမထပ်စေရန် Zawgyi သို့ ပြောင်းမည်
const zgSub = rabbit.uni2zg(uniSub);

// ၃ Zawgyi စာသားများဖြင့် .srt ဖိုင်အသစ် ပြန်ဆောက်မည်
fs.writeFileSync('test-sub-zg.srt', zgSub, 'utf8');

ffmpeg.setFfmpegPath('./ffmpeg.exe');

const videoInput = './input.mp4'; 
const audioInput = './output/test-audio.wav'; 
const videoOutput = './output/subtitle-video.mp4'; 

console.log("🎬 Zawgyi နည်းလမ်းဖြင့် စာတန်းထိုး ပေါင်းထည့်နေပါသည်...");

ffmpeg()
    .input(videoInput)
    .input(audioInput)
    .outputOptions([
        '-c:v libx264',
        '-c:a aac',     
        '-vf', 
        // 🔴 Zawgyi .srt ဖိုင်နှင့် Zawgyi-One ဖောင့်ကို ချိတ်ဆက်အသုံးပြုထားပါသည်
        "hflip,boxblur=2:1,subtitles=test-sub-zg.srt:fontsdir=.:force_style='Fontname=Zawgyi-One,FontSize=24'", 
        '-map 0:v:0',
        '-map 1:a:0',
        '-shortest'
    ])
    .save(videoOutput)
    .on('end', () => {
        console.log("✅ အောင်မြင်ပါသည်။ ထွက်လာသော ဗီဒီယိုကို ./output/subtitle-video.mp4 တွင် ကြည့်ရှုပါ။");
    })
    .on('error', (err) => {
        console.error("❌ အမှားအယွင်းဖြစ်ပေါ်သည်:", err.message);
    });
