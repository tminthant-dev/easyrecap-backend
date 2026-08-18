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

function formatAssTime(seconds) {
    const date = new Date(Math.floor(seconds * 1000));
    const h = date.getUTCHours();
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    const cs = String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
    return `${h}:${m}:${s}.${cs}`;
}

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
        return `&H00${b}${g}${r}`; 
    }
    return '&H00FFFFFF'; 
}

// ---------------------------------------------------------
// Main Processor (Trim & Video Background Blur System)
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
    2. Break the segments naturally at commas, full stops, or logical pauses.
    3. Return strictly as a JSON array of objects with "start" (seconds), "end" (seconds), and "text" (Burmese string).`;

    const aiResponse = await ai.models.generateContent({
        model: 'gemini-3.7-flash', 
        contents: [{ inlineData: { data: audioBase64, mimeType: 'audio/mp3' } }, promptText],
        config: {
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        }
    });

    if (!aiResponse || !aiResponse.text) {
        throw new Error("Gemini AI မှ စာသားပြန်မပေးပါ။");
    }

    let responseText = aiResponse.text.trim();
    responseText = responseText.replace(/```json/g, '').replace(/```/g, ''); 
    const translatedSegments = JSON.parse(responseText);
    
    if (translatedSegments.length === 0) throw new Error("ဘာသာပြန်ထားသော စာသားမရှိပါ။");

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

    const vSpeed = parseFloat(options.videoSpeed) || 1.0;
    const aSpeed = parseFloat(options.voiceSpeed) || 1.0;

    let pcmBuffers = []; 
    let assDialogues = ''; 
    let currentTimeline = 0; 

    for (let i = 0; i < audioDatas.length; i++) {
        let a = audioDatas[i];
        let targetDuration = a.newDuration / aSpeed; 
        assDialogues += generateAssDialogue(a.text, currentTimeline, targetDuration);
        pcmBuffers.push(a.ttsBuffer);
        currentTimeline += targetDuration;
    }

    const fullPcmBuffer = Buffer.concat(pcmBuffers);
    const generatedAudioPath = path.join(outputDir, 'myanmar-dub.wav');
    fs.writeFileSync(generatedAudioPath, addWavHeader(fullPcmBuffer, 24000));

    const spedUpAudioPath = path.join(outputDir, 'sped-up-audio.wav');
    await new Promise((resolve, reject) => {
        ffmpeg(generatedAudioPath)
            .audioFilters(`atempo=${aSpeed}`)
            .save(spedUpAudioPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });

    // ---------------------------------------------------------
    // 🔴 1. Video Trim & Concat 
    // ---------------------------------------------------------
    let vfFilters = [];
    let concatStr = "";

    for (let i = 0; i < audioDatas.length; i++) {
        let a = audioDatas[i];
        let origStart = a.start;
        let origEnd = a.end;
        let origDur = origEnd - origStart;
        if (origDur < 0.1) origDur = 0.1; 
        
        let targetDur = a.newDuration / aSpeed; 
        let ptsRatio = targetDur / origDur; 
        
        let outName = audioDatas.length > 1 ? `[v${i}]` : `[v_concat]`;
        
        vfFilters.push(`[${i}:v]trim=start=${origStart}:end=${origEnd},setpts=${ptsRatio}*(PTS-STARTPTS)${outName}`);
        
        if (audioDatas.length > 1) {
            concatStr += `[v${i}]`;
        }
    }

    if (audioDatas.length > 1) {
        vfFilters.push(`${concatStr}concat=n=${audioDatas.length}:v=1:a=0[v_concat]`);
    }

    // ---------------------------------------------------------
    // 🔴 2. Visual Effects & Blurred Background System
    // ---------------------------------------------------------
    let videoWidth = 1080;
    let videoHeight = 1920; 
    if (options.aspectRatio === '16:9') { videoWidth = 1920; videoHeight = 1080; } 
    else if (options.aspectRatio === '1:1') { videoWidth = 1080; videoHeight = 1080; }

    let flipEffect = (options.isFlipped === 'true' || options.isFlipped === true) ? ',hflip' : '';

    // 🔴 Video Background ကို အမည်းမဖြစ်စေဘဲ မူရင်းဗီဒီယိုကို Blur လုပ်ပြီး နောက်ခံထားခြင်း
    vfFilters.push(`[v_concat]split=2[bg_in][fg_in]`);
    // နောက်ခံ: မျက်နှာပြင်အပြည့်ဖြည့်ပြီး ပြင်းပြင်းထန်ထန် မှုန်ဝါးမည်
    vfFilters.push(`[bg_in]scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=increase,crop=${videoWidth}:${videoHeight},boxblur=40:5${flipEffect}[bg_blur]`);
    // အရှေ့ရုပ်ပုံ: အချိုးအစားမပျက်စေဘဲ မျက်နှာပြင်တွင် အလယ်တည့်တည့်၌ Fit ဖြစ်စေမည် (Crop မလုပ်ပါ)
    vfFilters.push(`[fg_in]scale=${videoWidth}:${videoHeight}:force_original_aspect_ratio=decrease${flipEffect}[fg_scaled]`);
    // နောက်ခံအဝါးပေါ်တွင် အရှေ့မှရုပ်ပုံကို ထပ်တင်မည်
    vfFilters.push(`[bg_blur][fg_scaled]overlay=(W-w)/2:(H-h)/2[v_base]`);

    if (options.isBlurred === 'true' || options.isBlurred === true) {
        const blurYPercent = parseFloat(options.blurY) || 80; 
        const boxW = Math.floor(videoWidth * 0.9);
        const boxH = Math.floor(videoHeight * 0.08); 
        const boxX = Math.floor((videoWidth - boxW) / 2);
        let boxY = Math.floor((videoHeight * (blurYPercent / 100)) - (boxH / 2));
        if (boxY < 0) boxY = 0;
        if (boxY + boxH > videoHeight) boxY = videoHeight - boxH;

        // စာတန်းထိုးနေရာရှိ သီးသန့် Glass Blur Effect
        vfFilters.push(`[v_base]split=2[sub_bg][sub_fg]`);
        vfFilters.push(`[sub_fg]crop=${boxW}:${boxH}:${boxX}:${boxY},boxblur=15:3[sub_blurred]`);
        vfFilters.push(`[sub_bg][sub_blurred]overlay=${boxX}:${boxY}[v_blurred]`);
    } else {
        vfFilters.push(`[v_base]copy[v_blurred]`);
    }

    const primaryColor = hexToAssColor(options.textColor);
    const fontSize = (parseInt(options.captionSize) || 12) * 6; 
    const captionYPercent = parseFloat(options.captionY) || 80;
    
    let marginV = Math.floor((videoHeight * (captionYPercent / 100)) - (fontSize / 2));
    if (marginV < 0) marginV = 0;
    if (marginV > videoHeight - fontSize) marginV = videoHeight - fontSize - 20;

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

    const absoluteAssPath = path.resolve(outputDir, 'auto-sub-zg.ass');
    const safeAssPath = absoluteAssPath.replace(/\\/g, '/').replace(/:/g, '\\:'); 
    
    vfFilters.push(`[v_blurred]subtitles='${safeAssPath}':fontsdir='.'[v_final]`);

    const videoFilterString = vfFilters.join(';');
    const videoOutput = path.join(outputDir, `final-recap-${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        console.log("🎬 FFmpeg ဖြင့် ဗီဒီယိုအား အသံနှင့်အညီ ဖြတ်တောက်ပေါင်းစပ်နေပါသည်...");
        
        let cmd = ffmpeg();
        
        for (let i = 0; i < audioDatas.length; i++) {
            cmd = cmd.input(videoInput);
        }
        
        cmd = cmd.input(spedUpAudioPath);

        cmd.complexFilter(videoFilterString)
            .outputOptions([
                '-map [v_final]', 
                `-map ${audioDatas.length}:a`, 
                '-c:v libx264',
                '-preset ultrafast',          
                '-threads 2',                 
                '-max_muxing_queue_size 1024',
                '-c:a aac',
                '-shortest' 
            ])
            .on('start', (commandLine) => console.log("⏳ Video Rendering စတင်နေပါပြီ..."))
            .on('progress', (progress) => {
                if (progress.timemark) {
                    process.stdout.write(`\r🔄 Processing: ${progress.timemark}   `);
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