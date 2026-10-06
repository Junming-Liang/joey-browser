/* Synthetic DIB operations only: no file/registry/network/user-data imports. */
typedef unsigned int DWORD;
typedef void *HANDLE;
#define API __declspec(dllimport) __stdcall
API HANDLE GetStdHandle(DWORD);
API int WriteFile(HANDLE,const void *,DWORD,DWORD *,void *);
API void ExitProcess(DWORD);
API HANDLE CreateCompatibleDC(HANDLE);
API int DeleteDC(HANDLE);
API HANDLE CreateDIBSection(HANDLE,const void *,unsigned int,void **,HANDLE,DWORD);
API HANDLE SelectObject(HANDLE,HANDLE);
API int DeleteObject(HANDLE);
API int SetDIBitsToDevice(HANDLE,int,int,DWORD,DWORD,int,int,unsigned int,unsigned int,const void *,const void *,unsigned int);
typedef struct {DWORD size;int width,height;unsigned short planes,bpp;DWORD compression,image_size;int xppm,yppm;DWORD used,important;} INFO;
typedef struct {int height,dx,dy,sx,sy;DWORD w,h,start,lines;} CASE;
static const CASE cases[]={
 {3,0,0,0,0,2,3,0,3},{-3,0,0,0,0,2,3,0,3},
 {3,0,0,0,0,2,2,0,3},{-3,0,0,0,0,2,2,0,3},
 {3,0,0,0,1,2,2,0,3},{-3,0,0,0,1,2,2,0,3},
 {3,-1,-1,0,0,2,3,0,3},{-3,-1,-1,0,0,2,3,0,3},
 {3,0,0,0,0,2,3,1,2},{-3,0,0,0,0,2,3,1,2},
 {3,0,0,0,1,2,2,1,2},{-3,0,0,0,1,2,2,1,2},
 {3,0,0,0,0,2,3,0,5},{-3,0,0,0,0,2,3,0,5},
 {3,0,0,-1,0,3,3,0,3},{3,7,7,0,0,2,3,0,3},
 {3,0,0,0,0,2,3,3,1},{3,0,0,0,0,2,3,0,0}
};
static const unsigned char source[40]={
 1,2,3,4,5,6,0,0,11,12,13,14,15,16,0,0,
 21,22,23,24,25,26,0,0,31,32,33,34,35,36,0,0,
 41,42,43,44,45,46,0,0
};
static char output[1024];
static unsigned int length;
static HANDLE stdout_handle;
static INFO target={40,4,-4,1,32,0,64,0,0,0,0};
static INFO info={40,2,3,1,24,0,24,0,0,0,0};
static void hex(DWORD value,unsigned int digits) {
 static const char alphabet[]="0123456789abcdef";
 while(digits){digits--;output[length++]=alphabet[(value>>(digits*4))&15];}
}
void mainCRTStartup(void) {
 stdout_handle=GetStdHandle((DWORD)-11);
 HANDLE dc=CreateCompatibleDC(0);if(!dc)ExitProcess(3);
 unsigned char *pixels=0;
 HANDLE bitmap=CreateDIBSection(dc,&target,0,(void **)&pixels,0,0);
 if(!bitmap||!pixels)ExitProcess(4);
 HANDLE previous=SelectObject(dc,bitmap);if(!previous)ExitProcess(5);
 for(unsigned int index=0;index<sizeof(cases)/sizeof(cases[0]);index++) {
  const CASE *c=&cases[index];
  info.height=c->height;
  for(unsigned int i=0;i<64;i++)pixels[i]=0xaa;
  int result=SetDIBitsToDevice(dc,c->dx,c->dy,c->w,c->h,c->sx,c->sy,c->start,c->lines,source,&info,0);
  output[length++]='D';output[length++]=' ';hex(index,8);output[length++]=' ';hex(result,8);
  for(unsigned int i=0;i<64;i++){output[length++]=' ';hex(pixels[i],2);}
  output[length++]='\n';DWORD written=0;
  if(!WriteFile(stdout_handle,output,length,&written,0)||written!=length)ExitProcess(2);
  length=0;
 }
 SelectObject(dc,previous);DeleteObject(bitmap);DeleteDC(dc);ExitProcess(0);
}
