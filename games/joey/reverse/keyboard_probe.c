/* Synthetic key states in the fresh task-owned desktop; no user data. */
typedef unsigned int DWORD;
typedef void *HANDLE;
#define API __declspec(dllimport) __stdcall
API HANDLE GetStdHandle(DWORD);
API int WriteFile(HANDLE,const void *,DWORD,DWORD *,void *);
API void ExitProcess(DWORD);
API HANDLE GetKeyboardLayout(DWORD);
API int ToAscii(unsigned int,unsigned int,const unsigned char *,unsigned short *,unsigned int);
API unsigned int MapVirtualKeyA(unsigned int,unsigned int);
static unsigned char keys[256];
static char output[100];
static unsigned int length;
static HANDLE stdout_handle;
static void hex(DWORD value,unsigned int digits) {
 static const char alphabet[]="0123456789abcdef";
 while(digits){digits--;output[length++]=alphabet[(value>>(digits*4))&15];}
}
static void flush(void) {
 DWORD written=0;
 if(!WriteFile(stdout_handle,output,length,&written,0)||written!=length)ExitProcess(2);
 length=0;
}
void mainCRTStartup(void) {
 stdout_handle=GetStdHandle((DWORD)-11);
 output[length++]='H';output[length++]=' ';hex((DWORD)GetKeyboardLayout(0),8);output[length++]='\n';flush();
 for(unsigned int modifiers=0;modifiers<16;modifiers++) {
  for(unsigned int key=0;key<256;key++) {
   for(unsigned int i=0;i<256;i++)keys[i]=0;
   if(modifiers&1)keys[0x10]=0x80;
   if(modifiers&2)keys[0x11]=0x80;
   if(modifiers&4)keys[0x12]=0x80;
   if(modifiers&8)keys[0x14]=1;
   keys[key]|=0x80;
   unsigned short word=0xa55a;
   int result=ToAscii(key,0,keys,&word,0);
   output[length++]='A';output[length++]=' ';hex(modifiers,8);output[length++]=' ';hex(key,8);
   output[length++]=' ';hex(result,8);output[length++]=' ';hex(word,4);output[length++]='\n';flush();
  }
 }
 for(unsigned int prefix=0;prefix<3;prefix++) {
  unsigned int high=prefix==1?0xe000:prefix==2?0xe100:0;
  for(unsigned int type=0;type<5;type++)for(unsigned int key=0;key<256;key++) {
   output[length++]='M';output[length++]=' ';hex(type,8);output[length++]=' ';hex(high|key,8);
   output[length++]=' ';hex(MapVirtualKeyA(high|key,type),8);output[length++]='\n';flush();
  }
 }
 ExitProcess(0);
}
