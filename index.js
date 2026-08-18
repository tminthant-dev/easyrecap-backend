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
import ffmpegStatic from 'ffmpeg-static';

const app = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.resolve('./uploads');
const outputDir = path.resolve('./output');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const upload = multer({ dest: uploadDir });

const proxyUrl = process.env.PROXY_URL; 
if (proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(dispatcher);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

ffmpeg.setFfmpegPath(ffmpegStatic);

// ---------------------------------------------------------
// Helper Functions
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

// 🔴 ASS Format အတွက် အချိန် Format ပြောင်းခြင်း (SRT နှင့် မတူပါ)
function formatAssTime(seconds) {
    const date = new Date(Math.floor(seconds * 1000));
    const h = date.getUTCHours();
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    const cs = String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
    return `${h}:${m}:${s}.${cs}`;
}

// 🔴 ASS format အတွက် စာတန်းထိုး လိုင်းများ ဖန်တီးခြင်း
function generateAssDialogue(text, currentTimeline, durationInSeconds) {
    let blocks = '';
    let cleanText = text.replace(/\n/g, ' ').trim();

    if (cleanText.length <= 35) {
        let startTime = formatAssTime(currentTimeline);
        let endTime = formatAssTime(currentTimeline + durationInSeconds);
        blocks += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${cleanText}\n`;
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
        let startTime = formatAssTime(tempTimeline);
        let endTime = formatAssTime(tempTimeline + chunkDuration);

        blocks += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${chunk}\n`;
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

function hexToAssColor(hex) {
    if (!hex || hex === 'transparent') return '&H00000000'; 
    hex = hex.replace('#', '');
    if (hex.length === 6) {
        let r = hex.substring(0, 2);
        let g = hex.substring(2, 4);
        let b = hex.substring(4, 6);
        return `&H00${b}${g}${r}`; // ASS format uses BBGGRR
    }
    return '&H00FFFFFF'; 
}

// ---------------------------------------------------------
// Main Processor
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
        contents: [{ inlineData: { data: audioBase64, mimeType: 'audio/mp3' } }, promptText]
    });

    let responseText = aiResponse.text.trim();
    responseText = responseText.replace(/```json/g, '').replace(/```/g, ''); 
    const translatedSegments = JSON.parse(responseText);

    console.log("🗣️ Edge TTS ဖြင့် မြန်မာအသံများ ဖန်တီးနေပါသည်...");
    let audioDatas = [];
    const tts = new MsEdgeTTS();
    
    let voiceModel = 'my-MM-ThihaNeural'; 
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
        audioDatas.push({ start: segment.start, end: segment.end, text: segment.text, ttsBuffer: buffer, newDuration: duration });
    }

    let maxStretchRatio = 1.0;
    for (let a of audioDatas) {
        let origDur = a.end - a.start;
        if (origDur < 0.5) origDur = 0.5; 
        let ratio = a.newDuration / origDur;
        if (ratio > maxStretchRatio) maxStretchRatio = ratio;
    }
    if (maxStretchRatio > 2.0) maxStretchRatio = 2.0; 

    const vSpeed = parseFloat(options.videoSpeed) || 1.0;
    const aSpeed = parseFloat(options.voiceSpeed) || 1.0;

    let pcmBuffers = []; 
    let assDialogues = ''; 
    let currentTimeline = 0; 

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

        let spedUpTimeline = currentTimeline / aSpeed;
        let spedUpDuration = a.newDuration / aSpeed;

        // 🔴 ASS Format ဖြင့် စာတန်းထိုး လိုင်းများ ပေါင်းထည့်ခြင်း
        assDialogues += generateAssDialogue(a.text, spedUpTimeline, spedUpDuration);
        
        pcmBuffers.push(a.ttsBuffer);
        currentTimeline += a.newDuration;
    }

    const fullPcmBuffer = Buffer.concat(pcmBuffers);
    const finalAudioBuffer = addWavHeader(fullPcmBuffer, 24000);
    const generatedAudioPath = path.join(outputDir, 'myanmar-dub.wav');
    fs.writeFileSync(generatedAudioPath, finalAudioBuffer);

    // ---------------------------------------------------------
    // FFmpeg Filter & Subtitle Configuration (Resolution များကို တိကျစွာ သတ်မှတ်သည်)
    // ---------------------------------------------------------
    let videoWidth = 1080;
    let videoHeight = 1920; 
    if (options.aspectRatio === '16:9') { videoWidth = 1920; videoHeight = 1080; } 
    else if (options.aspectRatio === '1:1') { videoWidth = 1080; videoHeight = 1080; }

    const primaryColor = hexToAssColor(options.textColor);
    
    // 🔴 Frontend မှ Size ကို Video Resolution နှင့် အချိုးကျစေရန် (x3 ဆ) မြှောက်ထားပါသည်
    const fontSize = (parseInt(options.captionSize) || 12) * 6; 
    const captionYPercent = parseFloat(options.captionY) || 80;
    
    // Y နေရာ အတိအကျ တွက်ချက်ခြင်း
    let marginV = Math.floor((videoHeight * (captionYPercent / 100)) - (fontSize / 2));
    if (marginV < 0) marginV = 0;
    if (marginV > videoHeight - fontSize) marginV = videoHeight - fontSize - 20;

    console.log("📝 Zawgyi ASS စာတန်းထိုး ဖန်တီးနေပါသည်...");
    
    // 🔴 ဤနေရာတွင် Resolution (PlayResX/Y) အား တိကျစွာ သတ်မှတ်ထားသဖြင့် နေရာ/Size လုံးဝ မလွဲတော့ပါ
    let assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Zawgyi-One,${fontSize},${primaryColor},&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,8,0,0,${marginV},0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    let fullAssContent = assHeader + assDialogues;
    const zgSub = rabbit.uni2zg(fullAssContent);
    const subtitleFileName = path.join(outputDir, 'auto-sub-zg.ass');
    fs.writeFileSync(subtitleFileName, zgSub, 'utf8');

    // Filters တည်ဆောက်ခြင်း
    let vfFilters = [];
    vfFilters.push(`setpts=${maxStretchRatio}*(1/${vSpeed})*PTS`);
    vfFilters.push(`scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=increase`);
    vfFilters.push(`crop=${videoWidth}:${videoHeight}`);
    if (options.isFlipped === 'true' || options.isFlipped === true) vfFilters.push('hflip');
    
    if (options.isBlurred === 'true' || options.isBlurred === true) {
        const blurYPercent = parseFloat(options.blurY) || 80; 
        const boxW = Math.floor(videoWidth * 0.9);
        const boxH = Math.floor(videoHeight * 0.12);
        const boxX = Math.floor((videoWidth - boxW) / 2);
        let boxY = Math.floor((videoHeight * (blurYPercent / 100)) - (boxH / 2));
        
        if (boxY < 0) boxY = 0;
        if (boxY + boxH > videoHeight) boxY = videoHeight - boxH;

        vfFilters.push(`drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=black@0.7:t=fill`); 
    }

    const absoluteAssPath = path.resolve(outputDir, 'auto-sub-zg.ass');
    const safeAssPath = absoluteAssPath.replace(/\\/g, '/').replace(/:/g, '\\:'); 
    
    // 🔴 တွက်ချက်ထားသည့် ASS ဖိုင်ကို တိုက်ရိုက် ထည့်သွင်းခြင်း
    vfFilters.push(`subtitles='${safeAssPath}':fontsdir='.'`);

    const videoFilterString = vfFilters.join(',');
    const audioFilterString = `atempo=${aSpeed}`;
    const videoOutput = path.join(outputDir, `final-recap-${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        console.log("🎬 FFmpeg Rendering စတင်နေပါသည်...");
        ffmpeg()
            .input(videoInput)         
            .input(generatedAudioPath) 
            .complexFilter([
                `[0:v]${videoFilterString}[v]`,
                `[1:a]atempo=${aSpeed},aresample=async=1:min_hard_comp=0.100000:first_pts=0[a]`
            ])
            .outputOptions([
                '-map [v]', 
                '-map [a]',
                '-c:v libx264',
                '-preset ultrafast',          
                '-threads 2',                 
                '-max_muxing_queue_size 1024',
                '-c:a aac',
                '-shortest',
                // 🔴 အရေးကြီးဆုံး: Video နဲ့ Audio ကို Sync အတင်းညှိခြင်း
                '-fflags +genpts',
                '-r 30' 
            ])
            .on('start', (commandLine) => console.log("⏳ Rendering..."))
            .save(videoOutput)
            .on('end', () => {
                console.log(`\n🎉 အောင်မြင်ပါသည်။`);
                resolve(videoOutput);
            })
            .on('error', (err) => {
                console.error("\n❌ FFmpeg Error:", err.message);
                reject(err);
            });
    });
}

// ---------------------------------------------------------
// Express APIs
// ---------------------------------------------------------
app.use('/output', express.static(path.resolve('./output')));

const historyFilePath = path.resolve('./history.json');
if (!fs.existsSync(historyFilePath)) fs.writeFileSync(historyFilePath, JSON.stringify([]));

app.get('/api/history', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(historyFilePath))); } 
    catch (error) { res.status(500).json({ error: "Failed to read history" }); }
});

app.post('/api/generate-recap', upload.single('videoFile'), async (req, res) => {
    try {
        console.log("📥 Frontend မှ Request လက်ခံရရှိပါသည်!");
        if (!req.file) return res.status(400).json({ error: "No video file provided." });

        const options = req.body;
        console.log("⚙️ အသုံးပြုမည့် Settings:", options);

        const finalVideoPath = await processVideoRecap(req.file.path, options);
        const fileName = path.basename(finalVideoPath);
        const videoServeUrl = `https://${req.get('host')}/output/${fileName}`;

        const history = JSON.parse(fs.readFileSync(historyFilePath));
        history.unshift({
            id: Date.now(),
            title: options.processingMode === "AI Story" ? "AI Story Recap" : "Easy Recap Video",
            date: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
            duration: "Generated",
            status: "Completed",
            thumbnail: "from-purple-600 to-indigo-700",
            videoUrl: videoServeUrl 
        });
        fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2));

        res.json({ success: true, message: "Recap successfully generated!", videoUrl: videoServeUrl });
    } catch (error) {
        console.error("❌ API Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Backend API Server running at Port ${PORT}`));