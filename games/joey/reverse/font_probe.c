/* Synthetic requests matching observed original CreateFontA calls. No user data. */
typedef unsigned int DWORD;
typedef unsigned short WCHAR;
typedef void *HANDLE;
#define API __declspec(dllimport) __stdcall
API HANDLE GetStdHandle(DWORD);
API int WriteFile(HANDLE,const void *,DWORD,DWORD *,void *);
API void ExitProcess(DWORD);
API DWORD GetACP(void);
API HANDLE CreateCompatibleDC(HANDLE);
API int DeleteDC(HANDLE);
API HANDLE CreateDIBSection(HANDLE,const void *,DWORD,void **,HANDLE,DWORD);
API HANDLE SelectObject(HANDLE,HANDLE);
API int DeleteObject(HANDLE);
API HANDLE CreateFontA(int,int,int,int,int,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,const char *);
API int GetTextFaceW(HANDLE,int,WCHAR *);
API int GetTextMetricsW(HANDLE,void *);
API int GetTextExtentPoint32W(HANDLE,const WCHAR *,int,void *);
API int TextOutW(HANDLE,int,int,const WCHAR *,int);
API int SetBkMode(HANDLE,int);
API DWORD SetTextColor(HANDLE,DWORD);
API DWORD SetBkColor(HANDLE,DWORD);
typedef struct {DWORD size;int width,height;unsigned short planes,bpp;DWORD compression,image_size;int xppm,yppm;DWORD used,important;} INFO;
typedef struct {int cx,cy;} SIZE;
static const char face[]={0xcb,0xce,0xcc,0xe5,0}; /* CP936: actual requested 宋体. */
static const WCHAR extra[]={0x653b,0x5b88,0x53d1,0x52a8,0x9b54,0x6cd5,0x5361,0x751f,0x8fd8,0x7684,0x5b9d,0x672d};
static const WCHAR samples[][16]={{'A','V','W','a',' ', '1','2','3','4',0}, {0x653b,'/', '1','2','3','4',' ',0x5b88,'/', '2','3','4','5',0}, {0x53d1,0x52a8,0x9b54,0x6cd5,0x5361,0}, {0x751f,0x8fd8,0x7684,0x5b9d,0x672d,0}};
static unsigned char metrics[60],*pixels;
static WCHAR selected[64];
static char output[65536];
static DWORD length;
static HANDLE stdout_handle;
static INFO info={40,192,-32,1,32,0,192*32*4,0,0,0,0};
/* The 18px bold dialog is observed in both the physical phone and original
   player-turn reproduction. Keep normal/bold and original quality variants. */
static const struct {int height,weight;DWORD quality;} profiles[]={
 {12,700,2},{12,700,3},{14,700,2},{14,700,3},
 {12,400,2},{12,400,3},{14,400,2},{14,400,3},
 {18,700,2},{18,700,3},{18,400,2},{18,400,3}};
#define PROFILE_COUNT (sizeof(profiles)/sizeof(profiles[0]))
static void hex(DWORD value,unsigned int digits){static const char alphabet[]="0123456789abcdef";while(digits){digits--;output[length++]=alphabet[(value>>(digits*4))&15];}}
static void word(DWORD value){output[length++]=' ';hex(value,8);}
static void flush(void){DWORD written=0;output[length++]='\n';if(!WriteFile(stdout_handle,output,length,&written,0)||written!=length)ExitProcess(2);length=0;}
static void clear(DWORD color){for(unsigned int i=0;i<192*32;i++){pixels[i*4]=color>>16;pixels[i*4+1]=color>>8;pixels[i*4+2]=color;pixels[i*4+3]=0;}}
static void image(unsigned int width){for(unsigned int y=0;y<32;y++)for(unsigned int x=0;x<width;x++)for(unsigned int c=0;c<3;c++)hex(pixels[(y*192+x)*4+c],2);}
void reference(void){
 stdout_handle=GetStdHandle((DWORD)-11);
 output[length++]='A';word(GetACP());flush();
 HANDLE dc=CreateCompatibleDC(0);if(!dc)ExitProcess(3);
 HANDLE bitmap=CreateDIBSection(dc,&info,0,(void **)&pixels,0,0);if(!bitmap||!pixels)ExitProcess(4);
 HANDLE oldBitmap=SelectObject(dc,bitmap);if(!oldBitmap)ExitProcess(5);
 for(unsigned int profile=0;profile<PROFILE_COUNT;profile++){
  int height=profiles[profile].height;DWORD quality=profiles[profile].quality;
  HANDLE font=CreateFontA(height,0,0,0,profiles[profile].weight,0,0,0,1,0,0,quality,0,face);if(!font)ExitProcess(6);
  HANDLE oldFont=SelectObject(dc,font);if(!oldFont)ExitProcess(7);
  for(unsigned int i=0;i<60;i++)metrics[i]=0xaa;
  int ok=GetTextMetricsW(dc,metrics),faceLength=GetTextFaceW(dc,64,selected);
  output[length++]='F';word(profile);word(height);word(quality);word(ok);word(profiles[profile].weight);word(faceLength);
  for(unsigned int i=0;i<60;i++){output[length++]=' ';hex(metrics[i],2);}
  for(int i=0;i<faceLength&&i<64;i++){output[length++]=' ';hex(selected[i],4);}flush();
  SetBkMode(dc,1);SetTextColor(dc,0xffffff);
  for(unsigned int sample=0;sample<4;sample++)for(unsigned int colors=0;colors<2;colors++){
   int count=0;while(samples[sample][count])count++;SIZE before={-1,-1},after={-1,-1};
   DWORD foreground=colors?0x563412:0xffffff,background=colors?0xd7b593:0;
   clear(background);SetTextColor(dc,foreground);SetBkColor(dc,background);
   int measured=GetTextExtentPoint32W(dc,samples[sample],count,&before),drawn=TextOutW(dc,4,4,samples[sample],count);
   int ok=GetTextExtentPoint32W(dc,samples[sample],count,&after);
   output[length++]='C';word(profile);word(sample);word(colors);word(measured);word(before.cx);word(before.cy);word(drawn);word(ok);word(after.cx);word(after.cy);output[length++]=' ';image(192);flush();
  }
  SetTextColor(dc,0xffffff);
  for(unsigned int i=0;i<95+sizeof(extra)/sizeof(extra[0]);i++){
   WCHAR ch=i<95?i+32:extra[i-95];SIZE size={-1,-1};clear(0);
   int measured=GetTextExtentPoint32W(dc,&ch,1,&size),drawn=TextOutW(dc,4,4,&ch,1);SIZE after={-1,-1};
   int measuredAfter=GetTextExtentPoint32W(dc,&ch,1,&after);
   output[length++]='G';word(profile);word(ch);word(measured);word(size.cx);word(size.cy);word(drawn);word(measuredAfter);word(after.cx);word(after.cy);output[length++]=' ';image(32);flush();
  }
  for(unsigned int sample=0;sample<4;sample++)for(unsigned int colors=0;colors<2;colors++){
   int count=0;while(samples[sample][count])count++;SIZE size={-1,-1};
   DWORD foreground=colors?0x563412:0xffffff,background=colors?0xd7b593:0;
   clear(background);SetTextColor(dc,foreground);SetBkColor(dc,background);
   int measured=GetTextExtentPoint32W(dc,samples[sample],count,&size),drawn=TextOutW(dc,4,4,samples[sample],count);
   output[length++]='T';word(profile);word(sample);word(colors);word(measured);word(size.cx);word(size.cy);word(drawn);output[length++]=' ';image(192);flush();
  }
  for(unsigned int mode=1;mode<=2;mode++)for(unsigned int location=0;location<3;location++)for(unsigned int colors=0;colors<2;colors++){
   int sample=1,count=0;while(samples[sample][count])count++;SIZE before={-1,-1},after={-1,-1};
   int x=location==0?4:location==1?-2:184,y=location==1?-3:4;
   DWORD foreground=colors?0x563412:0xffffff,background=colors?0xd7b593:0;
   clear(0x537da1);SetBkMode(dc,mode);SetTextColor(dc,foreground);SetBkColor(dc,background);
   int measured=GetTextExtentPoint32W(dc,samples[sample],count,&before),drawn=TextOutW(dc,x,y,samples[sample],count);
   int ok=GetTextExtentPoint32W(dc,samples[sample],count,&after);
   output[length++]='B';word(profile);word(sample);word(colors);word(mode);word((DWORD)x);word((DWORD)y);word(measured);word(before.cx);word(before.cy);word(drawn);word(ok);word(after.cx);word(after.cy);output[length++]=' ';image(192);flush();
  }
  {SIZE zero={-1,-1};int ok=GetTextExtentPoint32W(dc,samples[0],0,&zero);output[length++]='Z';word(profile);word(ok);word(zero.cx);word(zero.cy);flush();}
  SelectObject(dc,oldFont);DeleteObject(font);
 }
 SelectObject(dc,oldBitmap);DeleteObject(bitmap);DeleteDC(dc);ExitProcess(0);
}

#ifdef FONT_ATLAS
#include "cp936-glyphs.h"
API DWORD GetGlyphIndicesW(HANDLE,const WCHAR *,int,unsigned short *,DWORD);
static unsigned char binary[2048];
static unsigned char before_width[sizeof(atlas_chars)/sizeof(atlas_chars[0])];
static void emit(const void *data,DWORD size){DWORD written=0;if(!WriteFile(stdout_handle,data,size,&written,0)||written!=size)ExitProcess(20);}
static unsigned char ramp[]={0,77,104,124,140,154,167,178,189,199,208,217,225,233,240,248,255};
static unsigned char level(unsigned char value){for(unsigned int i=0;i<17;i++)if(ramp[i]==value)return i;ExitProcess(21);return 0;}
void mainCRTStartup(void){
 stdout_handle=GetStdHandle((DWORD)-11);emit("JYGR3",5);
 unsigned short count=sizeof(atlas_chars)/sizeof(atlas_chars[0]);emit(&count,2);
 unsigned short profile_count=PROFILE_COUNT;emit(&profile_count,2);
 HANDLE dc=CreateCompatibleDC(0);HANDLE bitmap=CreateDIBSection(dc,&info,0,(void **)&pixels,0,0);HANDLE oldBitmap=SelectObject(dc,bitmap);
 for(unsigned int profile=0;profile<PROFILE_COUNT;profile++){
  unsigned short height=profiles[profile].height,weight=profiles[profile].weight;
  unsigned char quality=profiles[profile].quality;
  emit(&height,2);emit(&weight,2);emit(&quality,1);
  HANDLE font=CreateFontA(height,0,0,0,weight,0,0,0,1,0,0,quality,0,face);HANDLE oldFont=SelectObject(dc,font);
  if(!font||!oldFont||!GetTextMetricsW(dc,metrics))ExitProcess(22);emit(metrics,60);
  SetBkMode(dc,1);SetTextColor(dc,0xffffff);
  for(unsigned int i=0;i<count;i++){SIZE size;if(!GetTextExtentPoint32W(dc,atlas_chars+i,1,&size)||size.cx<0||size.cx>255)ExitProcess(23);before_width[i]=size.cx;}
  for(unsigned int i=0;i<count;i++){
   WCHAR ch=atlas_chars[i];SIZE after;unsigned short index;clear(0);
   if(!TextOutW(dc,4,4,&ch,1)||!GetTextExtentPoint32W(dc,&ch,1,&after)||GetGlyphIndicesW(dc,&ch,1,&index,0)==0xffffffff)ExitProcess(24);
   int left=32,top=32,right=0,bottom=0;
   for(int y=0;y<32;y++)for(int x=0;x<32;x++)if(pixels[(y*192+x)*4]){if(x<left)left=x;if(y<top)top=y;if(x+1>right)right=x+1;if(y+1>bottom)bottom=y+1;}
   if(!right){left=4;top=4;right=4;bottom=4;}
   if(left==0||right==32||top==0||bottom==32)ExitProcess(25);
   unsigned int n=0;binary[n++]=ch;binary[n++]=ch>>8;binary[n++]=index;binary[n++]=index>>8;binary[n++]=before_width[i];binary[n++]=after.cx;binary[n++]=left-4;binary[n++]=top-4;binary[n++]=right-left;binary[n++]=bottom-top;
   for(int y=top;y<bottom;y++)for(int x=left;x<right;x++)binary[n++]=level(pixels[(y*192+x)*4]);
   emit(binary,n);
  }
  SelectObject(dc,oldFont);DeleteObject(font);
 }
 SelectObject(dc,oldBitmap);DeleteObject(bitmap);DeleteDC(dc);ExitProcess(0);
}
#else
void mainCRTStartup(void){reference();}
#endif
