'use strict';
/**
 * DARK ANGEL receptor. Este projeto usa whatsapp-web.js (integração não oficial).
 * Necessita ser executado por uma pessoa responsável com permissão para administrar
 * uma conta de WhatsApp e participar do grupo. Não envie QR/códigos para terceiros.
 * Não disponibiliza tokens, QR ou sessões via HTTP.
 */
require('dotenv').config();
const path = require('node:path');
const { spawn } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const QR = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT || 3000);
const INVITE_CODE = (process.env.GROUP_INVITE_CODE || '').trim().replace(/^.*chat\.whatsapp\.com\//, '').split(/[?&#]/)[0];
const app = express();
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');next()});
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'..','index.html')));
let connected = false;
let groupId = null;
const client = new Client({
  authStrategy: new LocalAuth({dataPath:process.env.AUTH_DATA_PATH||path.join(__dirname,'.wwebjs_auth')}),
  puppeteer: {headless:true, ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}
});
client.on('qr', code=>{
  connected=false;
  console.log('\nUse Dispositivos conectados no SEU WhatsApp para ler o QR abaixo. Nunca compartilhe com outras pessoas.');
  QR.generate(code,{small:true});
});
client.on('auth_failure', err=>{connected=false;groupId=null;console.error('Falha na autenticação:',String(err))});
client.on('disconnected', reason=>{connected=false;groupId=null;console.error('WhatsApp desconectado:', reason)});
client.on('ready', async ()=>{
  connected=true;
  console.log('WhatsApp conectado. Procurando grupo receptor...');
  if (!INVITE_CODE) {console.error('Configure GROUP_INVITE_CODE em .env');return;}
  try{
    const info=await client.getInviteInfo(INVITE_CODE);
    const gid=info?.gid?._serialized || info?.gid?.toString?.() || null;
    if(gid && gid.endsWith('@g.us')){
      try{const chat=await client.getChatById(gid);if(chat?.isGroup)groupId=gid}catch(e){}
    }
    if(!groupId){
      // Entra apenas no grupo cujo convite foi fornecido pelo próprio administrador.
      const joined=await client.acceptInvite(INVITE_CODE);
      if(typeof joined==='string'&&joined.endsWith('@g.us'))groupId=joined;
    }
    if(groupId)console.log('Grupo receptor pronto:',groupId);
    else console.error('O grupo requer aprovação ou não foi possível localizar. Adicione o bot ao grupo e reinicie.');
  }catch(err){console.error('Não foi possível conectar ao grupo receptor. Confira convite/aprovação:',err.message)}
});

app.get('/api/status', (req,res)=>res.json({connected,groupReady:Boolean(groupId)}));
const onlyUploads=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024, files:1}});
const limit=rateLimit({windowMs:15*60*1000,limit:6,standardHeaders:'draft-7',legacyHeaders:false,message:{ok:false,error:'Limite de envios atingido. Tente novamente mais tarde.'}});

function convertWebmToMp4(buffer) {
  return fs.mkdtemp(path.join(os.tmpdir(),'dark-angel-')).then(async dir=>{
    const input=path.join(dir,'in.webm'), output=path.join(dir,'out.mp4');
    try{
      await fs.writeFile(input,buffer);
      await new Promise((resolve,reject)=>{
        const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',input,'-t','10','-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-movflags','+faststart',output]);
        ff.on('error', ()=>reject(new Error('O servidor precisa ter o FFmpeg instalado.')));
        ff.on('close',code=>code===0?resolve():reject(new Error('Conversão do vídeo falhou.')));
      });
      return await fs.readFile(output);
    }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
  });
}
app.post('/api/send-to-receiver',limit,onlyUploads.single('file'),async(req,res)=>{
  if(!connected||!groupId)return res.status(503).json({ok:false,error:'Bot ou grupo receptor não conectado.'});
  const kind=req.body?.kind,sound=req.body?.sound;
  if(req.body?.consent!=='yes')return res.status(400).json({ok:false,error:'Confirme a autorização de menção no site.'});
  const rawPhone=String(req.body?.phone||'').replace(/\D/g,'');
  const phone=rawPhone.startsWith('55')&&rawPhone.length>=12?rawPhone:'55'+rawPhone;
  if(!/^55[1-9][0-9](?:9[0-9]{8}|[2-9][0-9]{7})$/.test(phone))return res.status(400).json({ok:false,error:'Informe um número de WhatsApp brasileiro válido com DDD.'});
  const file=req.file;
  if(!file||!file.buffer?.length)return res.status(400).json({ok:false,error:'Nenhum arquivo recebido.'});
  if(!['image','video'].includes(kind))return res.status(400).json({ok:false,error:'Tipo de mídia inválido.'});
  if(kind==='image'&&file.mimetype!=='image/png')return res.status(415).json({ok:false,error:'A foto precisa ser PNG.'});
  if(kind==='video'&&file.mimetype!=='video/webm')return res.status(415).json({ok:false,error:'O vídeo precisa ser WebM.'});
  async function notifyCreator(){
    try{
      // Não mencione/mostre o número de alguém que não é membro do grupo.
      const chat=await client.getChatById(groupId);
      const member=chat?.participants?.some(p=>p.id?._serialized===`${phone}@c.us`);
      if(!member)return false;
      await client.sendMessage(groupId,`👼 DARK ANGEL • Criação recebida de @${phone}`,{mentions:[`${phone}@c.us`]});
      return true;
    }catch(err){console.error('Não foi possível marcar o número no grupo:',err.message);return false;}
  }
  try{
    if(kind==='image'){
      const media=new MessageMedia('image/png',file.buffer.toString('base64'),'dark-angel.png');
      await client.sendMessage(groupId,media,{sendMediaAsSticker:true,stickerName:'DARK ANGEL',stickerAuthor:'DARK ANGEL BOT'});
      const marked=await notifyCreator();return res.json({ok:true,message:marked?'✅ Figurinha enviada! Marcação enviada no grupo.':'✅ Figurinha enviada, mas o número não está no grupo ou a menção falhou.'});
    }
    const mp4=await convertWebmToMp4(file.buffer);
    const media=new MessageMedia('video/mp4',mp4.toString('base64'),'dark-angel.mp4');
    if(sound==='mute'){
      try{
        await client.sendMessage(groupId,media,{sendMediaAsSticker:true,stickerName:'DARK ANGEL',stickerAuthor:'DARK ANGEL BOT'});
        const marked=await notifyCreator();return res.json({ok:true,message:marked?'✅ Figurinha animada enviada! Marcação enviada.':'✅ Figurinha enviada, mas o número não está no grupo ou a menção falhou.'});
      }catch(err){console.warn('Sticker animado não suportado; enviando como vídeo:',err.message)}
    }
    await client.sendMessage(groupId,media,{caption:'DARK ANGEL BOT • vídeo'+(sound==='mute'?' sem áudio':' com áudio')});
    const marked=await notifyCreator();return res.json({ok:true,message:marked?'✅ Vídeo enviado! Marcação enviada no grupo.':'✅ Vídeo enviado, mas o número não está no grupo ou a menção falhou.'});
  }catch(err){console.error('Erro no envio ao receptor:',err);return res.status(502).json({ok:false,error:'O WhatsApp não confirmou o envio. Verifique a conexão do bot e tente novamente.'})}
});
app.use((err,req,res,next)=>{
  if(err?.code==='LIMIT_FILE_SIZE')return res.status(413).json({ok:false,error:'Arquivo acima do limite de 15 MB.'});
  if(err)return res.status(400).json({ok:false,error:'Não foi possível receber o arquivo.'});
  next();
});
app.get('/health',(req,res)=>res.status(200).json({ok:true,service:'dark-angel'}));
app.listen(PORT,()=>console.log(`Site DARK ANGEL disponível na porta ${PORT}`));
client.initialize().catch(err=>console.error('Erro ao iniciar WhatsApp Web:',err));
