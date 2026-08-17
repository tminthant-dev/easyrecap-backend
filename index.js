import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import rabbit from 'rabbit-node';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// ---------------------------------------------------------
// ၁။ API Server နှင့် Upload Directories တည်ဆောက်ခြင်း
// ---------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.resolve('./uploads');
const outputDir = path.resolve('./output');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('output')) fs.mkdirSync('output');

// Multer Setup (Video များကို uploads/ ထဲတွင် ယာယီသိမ်းမည်)
const upload = multer({ dest: uploadDir });

// ---------------------------------------------------------
// ၂။ Proxy နှင့် API သတ်မှတ်ခြင်း
// ---------------------------------------------------------
const proxyUrl = process.env.PROXY_URL; 
if (proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(dispatcher);
}

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

import ffmpegStatic from 'ffmpeg-static';
ffmpeg.setFfmpegPath(ffmpegStatic);


// ---------------------------------------------------------
// ၃။ Helper Functions များ
// ---------------------------------------------------------
function addWavHeader(pcmBuffer, sampleRate = 24000) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); 
    header.writeUInt16LE(1, 20);  
    header.writeUInt16LE(1, 22);  
    header.writeUInt32LE(sampleRate, 24); 
    header.writeUInt32LE(sampleRate * 2, 28); 
    header.writeUInt16LE(2, 32);  
    header.writeUInt16LE(16, 34); 
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([header, pcmBuffer]);
}

function convertMp3ToPcm(mp3Path) {
    return new Promise((resolve, reject) => {
        let chunks = [];
        ffmpeg(mp3Path)
            .format('s16le') 
            .audioChannels(1) 
            .audioFrequency(24000) 
            .on('error', (err) => reject(err))
            .pipe()
            .on('data', (chunk) => chunks.push(chunk))
            .on('end', () => resolve(Buffer.concat(chunks)));
    });
}

function formatSrtTime(seconds) {
    const date = new Date(Math.floor(seconds * 1000));
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss},${ms}`;
}

function generateDynamicSubtitles(text, currentTimeline, durationInSeconds, srtTracker) {
    let blocks = '';
    let cleanText = text.replace(/\n/g, ' ').trim();

    if (cleanText.length <= 35) {
        let startTime = formatSrtTime(currentTimeline);
        let endTime = formatSrtTime(currentTimeline + durationInSeconds);
        blocks += `${srtTracker.index++}\n${startTime} --> ${endTime}\n${cleanText}\n\n`;
        return blocks;
    }

    let chunks = [];
    let words = cleanText.split(' ').filter(w => w.trim() !== '');
    
    if (words.length > 3) {
        let currentChunk = '';
        for (let i = 0; i < words.length; i++) {
            currentChunk += words[i] + ' ';
            if (currentChunk.trim().length >= 30 || i === words.length - 1) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
        }
    } else {
        for (let i = 0; i < cleanText.length; i += 30) {
            chunks.push(cleanText.substring(i, i + 30));
        }
    }

    let totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    let tempTimeline = currentTimeline;

    for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i];
        let chunkDuration = (chunk.length / totalLength) * durationInSeconds;
        let startTime = formatSrtTime(tempTimeline);
        let endTime = formatSrtTime(tempTimeline + chunkDuration);

        blocks += `${srtTracker.index++}\n${startTime} --> ${endTime}\n${chunk}\n\n`;
        tempTimeline += chunkDuration; 
    }

    return blocks;
}

function extractAudioFromVideo(videoPath, audioOutputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .outputOptions(['-vn', '-acodec libmp3lame', '-q:a 2'])
            .save(audioOutputPath)
            .on('end', () => resolve(audioOutputPath))
            .on('error', (err) => reject(err));
    });
}

// React မှလာသော Hex အရောင် (ဥပမာ #ffffff) ကို FFmpeg ASS Format (BGR) သို့ ပြောင်းပေးသည့် Function
function hexToAssColor(hex) {
    if (!hex || hex === 'transparent') return '&HFF000000'; // Invisible
    hex = hex.replace('#', '');
    if (hex.length === 6) {
        let r = hex.substring(0, 2);
        let g = hex.substring(2, 4);
        let b = hex.substring(4, 6);
        return `&H00${b}${g}${r}`; 
    }
    return '&H00FFFFFF'; // Default White
}

// ---------------------------------------------------------
// ၄။ ပင်မ Automation Function (Dynamic Options ဖြင့်)
// ---------------------------------------------------------
async function processVideoRecap(videoInput, options) {
    const extractedAudioPath = path.join(outputDir, 'extracted-original.mp3');

    console.log("🎧 မူရင်းဗီဒီယိုမှ အသံကို ခွဲထုတ်နေပါသည်...");
    await extractAudioFromVideo(videoInput, extractedAudioPath);
    
    console.log("🤖 Gemini ဖြင့် ဘာသာပြန်နေပါသည်...");
    const audioBuffer = fs.readFileSync(extractedAudioPath);
    const audioBase64 = audioBuffer.toString('base64');

    const promptText = `Listen to the audio. Transcribe and translate into a natural, engaging Burmese movie recap storytelling style. 
    CRITICAL RULES:
    1. Keep the translation smooth and continuous. Do NOT break the text into choppy, unnatural fragments.
    2. Break the segments naturally at commas, full stops, or logical pauses (around 4 to 8 seconds per segment).
    3. Ensure the tone sounds like a human telling a story.
    Return strictly as a JSON array of objects with "start" (seconds), "end" (seconds), and "text" (Burmese string).`;

    const aiResponse = await ai.models.generateContent({
        model: 'gemini-3.7-flash', 
        contents: [
            { inlineData: { data: audioBase64, mimeType: 'audio/mp3' } },
            promptText
        ]
    });

    let responseText = aiResponse.text.trim();
    responseText = responseText.replace(/```json/g, '').replace(/```/g, ''); 
    const translatedSegments = JSON.parse(responseText);

    console.log("🗣️ Edge TTS ဖြင့် မြန်မာအသံများ ဖန်တီးနေပါသည်...");
    let audioDatas = [];
    const tts = new MsEdgeTTS();
    
    // Frontend မှရွေးချယ်လိုက်သော အသံကို ထည့်သွင်းခြင်း
    let voiceModel = 'my-MM-ThihaNeural'; // Default
    if (options.aiVoice && options.aiVoice.includes('Female')) voiceModel = 'my-MM-NilarNeural';
    
    await tts.setMetadata(voiceModel, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

    for (let i = 0; i < translatedSegments.length; i++) {
        let segment = translatedSegments[i];
        
        const tempSegmentDir = path.join(outputDir, `segment-folder-${i}`);
        if (!fs.existsSync(tempSegmentDir)) fs.mkdirSync(tempSegmentDir, { recursive: true });
        
        await tts.toFile(tempSegmentDir, segment.text);
        const actualMp3Path = path.join(tempSegmentDir, 'audio.mp3');
        let buffer = await convertMp3ToPcm(actualMp3Path);
        
        if (fs.existsSync(actualMp3Path)) fs.unlinkSync(actualMp3Path);
        if (fs.existsSync(tempSegmentDir)) fs.rmdirSync(tempSegmentDir);
        
        let duration = buffer.length / 48000; 
        audioDatas.push({
            start: segment.start,
            end: segment.end,
            text: segment.text,
            ttsBuffer: buffer, 
            newDuration: duration
        });
    }

    let maxStretchRatio = 1.0;
    for (let a of audioDatas) {
        let origDur = a.end - a.start;
        if (origDur < 0.5) origDur = 0.5; 
        let ratio = a.newDuration / origDur;
        if (ratio > maxStretchRatio) maxStretchRatio = ratio;
    }
    if (maxStretchRatio > 2.0) maxStretchRatio = 2.0; 

    let pcmBuffers = []; 
    let srtContent = '';
    let currentTimeline = 0; 
    let srtTracker = { index: 1 }; 

    for (let i = 0; i < audioDatas.length; i++) {
        let a = audioDatas[i];
        let scaledStart = a.start * maxStretchRatio;
        if (scaledStart < currentTimeline) scaledStart = currentTimeline;

        let gap = scaledStart - currentTimeline;
        if (gap > 0) {
            let silentBytes = Math.floor(gap * 48000);
            if (silentBytes % 2 !== 0) silentBytes -= 1;
            pcmBuffers.push(Buffer.alloc(silentBytes));
            currentTimeline = scaledStart;
        }

        srtContent += generateDynamicSubtitles(a.text, currentTimeline, a.newDuration, srtTracker);
        pcmBuffers.push(a.ttsBuffer);
        currentTimeline += a.newDuration;
    }

    const fullPcmBuffer = Buffer.concat(pcmBuffers);
    const finalAudioBuffer = addWavHeader(fullPcmBuffer, 24000);
    const generatedAudioPath = path.join(outputDir, 'myanmar-dub.wav');
    fs.writeFileSync(generatedAudioPath, finalAudioBuffer);

    console.log("📝 Zawgyi စာတန်းထိုး ဖန်တီးနေပါသည်...");
    const zgSub = rabbit.uni2zg(srtContent);
    const subtitleFileName = path.join(outputDir, 'auto-sub-zg.srt');
    fs.writeFileSync(subtitleFileName, zgSub, 'utf8');
    
        // ---------------------------------------------------------
    // ၅။ Frontend မှလာသော Settings များအရ FFmpeg Video Filters များကို ဖန်တီးခြင်း
    // ---------------------------------------------------------
    let vfFilters = [];
    
    // အသံနှင့် ရုပ် ကိုက်ညီစေရန်
    vfFilters.push(`setpts=${maxStretchRatio}*PTS`);

    let videoWidth = 1080;
    let videoHeight = 1920; 

    if (options.aspectRatio === '9:16') {
        videoWidth = 1080; videoHeight = 1920;
    } else if (options.aspectRatio === '16:9') {
        videoWidth = 1920; videoHeight = 1080;
    } else if (options.aspectRatio === '1:1') {
        videoWidth = 1080; videoHeight = 1080;
    }

    vfFilters.push(`scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=increase`);
    vfFilters.push(`crop=${videoWidth}:${videoHeight}`);
    
    // ၂။ ဗီဒီယိုလှန်ခြင်း
    if (options.isFlipped === 'true' || options.isFlipped === true) {
        vfFilters.push('hflip');
    }
    
    // ၃။ မူရင်းစာတန်းထိုးအား ဖုံးအုပ်ရန် (Black Box နေရာကို ပြင်ထားပါသည်)
    if (options.isBlurred === 'true' || options.isBlurred === true) {
        // Letterbox ဗီဒီယိုများအတွက် စာတန်းက အလယ်နားရောက်နေတတ်၍ y နေရာကို ih*0.65 သို့ ရွှေ့ပေးထားပါသည်
        vfFilters.push('drawbox=x=0:y=ih*0.65:w=iw:h=150:color=black@0.9:t=fill'); 
    }

    // ၄။ စာတန်းထိုး အရောင်၊ နောက်ခံနှင့် နေရာချထားမှု
    const primaryColor = hexToAssColor(options.textColor);
    const backColor = hexToAssColor(options.bgColor);
    
    let marginV = 80; 

    if (options.captionPosition === 'Top') {
        marginV = videoHeight - 180; 
    } else if (options.captionPosition === 'Middle') {
        marginV = Math.floor(videoHeight / 2) - 30; 
    }

    // 🔴 ၅။ စာတန်းထိုး ဖိုင်လမ်းကြောင်းကို Absolute Path သို့ ပြောင်းပေးခြင်း (အရေးကြီးသည်)
    const absoluteSrtPath = path.resolve(outputDir, 'auto-sub-zg.srt');
    const safeSubtitlePath = absoluteSrtPath.replace(/\\/g, '/').replace(/:/g, '\\:'); 
    
    const assStyle = `Fontname=Zawgyi-One,FontSize=22,PrimaryColour=${primaryColor},BackColour=${backColor},BorderStyle=3,Outline=1,Alignment=2,MarginV=${marginV}`;
    
    // fontsdir ကို Root Directory အဖြစ် သေချာစွာ သတ်မှတ်ပေးခြင်း
    vfFilters.push(`subtitles=${safeSubtitlePath}:fontsdir=.:force_style='${assStyle}'`);

    const finalVfString = vfFilters.join(',');
    const videoOutput = path.join(outputDir, `final-recap-${Date.now()}.mp4`);


        return new Promise((resolve, reject) => {
        console.log("🎬 FFmpeg ဖြင့် နောက်ဆုံးဗီဒီယိုကို ပေါင်းစပ်နေပါသည်...");
        ffmpeg()
            .input(videoInput)         
            .input(generatedAudioPath) 
            .outputOptions([
                '-c:v libx264',
                // 🔴 Railway တွင် RAM မလောက်သည့် ပြဿနာကို ဖြေရှင်းရန် အောက်ပါ ၃ ကြောင်းကို ထည့်ပါ
                '-preset ultrafast',          // ပေါင်းစပ်မှုကို အမြန်ဆုံးလုပ်စေပြီး RAM စားသက်သာစေသည်
                '-threads 2',                 // CPU နှင့် RAM အသုံးပြုမှုကို ကန့်သတ်ထားမည်
                '-max_muxing_queue_size 1024',// Memory ထဲတွင် ဗီဒီယိုဖိုင်များ ပုံနေခြင်းကို တားဆီးပေးမည်
                
                '-c:a aac',     
                '-vf', finalVfString, 
                '-map 0:v:0', 
                '-map 1:a:0', 
                '-shortest' 
            ])
            .on('start', (commandLine) => {
                console.log("🛠️ FFmpeg Command လမ်းကြောင်း အောင်မြင်ပါသည်");
                console.log("⏳ Video Rendering စတင်နေပါပြီ။ ခေတ္တစောင့်ဆိုင်းပေးပါ... (အချိန်အနည်းငယ် ကြာနိုင်ပါသည်)");
            })

                        // 🔴 အလုပ်လုပ်နေကြောင်း သိသာစေရန် Progress ထည့်သွင်းခြင်း (Time ဖြင့်ပြမည်)
            .on('progress', (progress) => {
                // ရာခိုင်နှုန်းသည် Stretch လုပ်ထားသဖြင့် 100 ကျော်သွားနိုင်သောကြောင့် အချိန် (Timemark) ကိုသာ ပြသပါမည်
                if (progress.timemark) {
                    process.stdout.write(`\r🔄 ဖြတ်တောက်ပေါင်းစပ်နေသည်... (ပြီးစီးသည့်အပိုင်း - ${progress.timemark})   `);
                } else {
                    process.stdout.write(`\r🔄 Processing...   `);
                }
            })

            .save(videoOutput)
            .on('end', () => {
                console.log(`\n🎉 အောင်မြင်ပါသည်။ ပြီးစီးသွားသော ဗီဒီယို: ${videoOutput}`);
                resolve(videoOutput);
            })
            .on('error', (err) => {
                console.error("\n❌ FFmpeg အမှားအယွင်း:", err.message);
                reject(err);
            });
    });

}

// ---------------------------------------------------------
// ၆။ Express API Routes
// ---------------------------------------------------------
// 🔴 6.0 - Frontend မှ ဗီဒီယိုများကို တိုက်ရိုက် ဖွင့်ကြည့်နိုင်/ဒေါင်းလုဒ်လုပ်နိုင်ရန် Static Folder ဖွင့်ပေးခြင်း
app.use('/output', express.static(path.resolve('./output')));

const historyFilePath = path.resolve('./history.json');

if (!fs.existsSync(historyFilePath)) {
    fs.writeFileSync(historyFilePath, JSON.stringify([]));
}

app.get('/api/history', (req, res) => {
    try {
        const historyData = JSON.parse(fs.readFileSync(historyFilePath));
        res.json(historyData);
    } catch (error) {
        res.status(500).json({ error: "Failed to read history" });
    }
});

app.post('/api/generate-recap', upload.single('videoFile'), async (req, res) => {
    try {
        console.log("📥 Frontend မှ Request လက်ခံရရှိပါသည်!");
        
        let videoInputPath = '';
        if (req.file) {
            videoInputPath = req.file.path; 
        } else if (req.body.videoUrl) {
            return res.status(400).json({ error: "Currently only file upload is supported." });
        } else {
            return res.status(400).json({ error: "No video file provided." });
        }

        const options = req.body;
        console.log("⚙️ အသုံးပြုမည့် Settings:", options);

        const finalVideoPath = await processVideoRecap(videoInputPath, options);

        // 🔴 ဖိုင်လမ်းကြောင်းအရှည်ကြီးအစား Frontend မှ ယူသုံးနိုင်သော Network URL အဖြစ် ပြောင်းပေးခြင်း
        const fileName = path.basename(finalVideoPath);
        // အသစ် (Dynamic URL)
        const videoServeUrl = `${req.protocol}://${req.get('host')}/output/${fileName}`;


        const history = JSON.parse(fs.readFileSync(historyFilePath));
        const newProject = {
            id: Date.now(),
            title: options.processingMode === "AI Story" ? "AI Story Recap" : "Easy Recap Video",
            date: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
            duration: "Generated",
            status: "Completed",
            thumbnail: "from-purple-600 to-indigo-700",
            videoUrl: videoServeUrl // URL အသစ်ကိုသာ သိမ်းမည်
        };
        
        history.unshift(newProject); 
        fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2));

        res.json({
            success: true,
            message: "Recap successfully generated!",
            videoUrl: videoServeUrl 
        });

    } catch (error) {
        console.error("❌ API Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
// Railway တွင် အလုပ်လုပ်ရန် '0.0.0.0' ကို မဖြစ်မနေ ထည့်ပေးရပါမည်
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend API Server running at Port ${PORT}`);
});
