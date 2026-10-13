/* Synthetic 1-bit DIB reference: no user files, registry or network access. */
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
typedef struct {INFO header;DWORD colors[2];} PALETTED;
typedef struct {int height,dx,dy,sx,sy;DWORD w,h,start,lines;} CASE;
static const CASE cases[]={
 {3,0,0,0,0,13,3,0,3},{-3,0,0,0,0,13,3,0,3},
 {3,0,0,1,0,12,3,0,3},{-3,0,0,1,0,12,3,0,3},
 {3,0,0,7,0,6,3,0,3},{-3,0,0,8,0,5,3,0,3},
 {3,0,0,9,1,4,2,0,3},{-3,0,0,9,1,4,2,0,3},
 {3,-2,-1,1,0,12,3,0,3},{-3,14,2,7,0,6,3,0,3},
 {3,0,0,0,0,13,3,1,2},{-3,0,0,0,0,13,3,1,2},
 {3,0,0,1,1,12,2,1,2},{-3,0,0,1,1,12,2,1,2},
 {3,0,0,-1,0,14,3,0,3},{3,0,0,0,0,13,3,3,1},
 {3,0,0,0,0,13,3,0,0},{-3,0,0,0,0,13,3,0,5}
};
/* Distinct rows; low unused bits and DWORD padding deliberately contain noise. */
static const unsigned char source[20]={
 0xa5,0xc8,0xee,0x11,0x63,0x57,0xdd,0x22,0x96,0xa3,0xcc,0x33,
 0x0f,0xf8,0xbb,0x44,0xf0,0x07,0xaa,0x55
};
static char output[1024];
static unsigned int length;
static INFO target={40,16,-4,1,32,0,256,0,0,0,0};
static PALETTED info={{40,13,3,1,1,0,12,0,0,0,0},{0x000c2238,0x00f08024}};
static void hex(DWORD value,unsigned int digits) {
 static const char alphabet[]="0123456789abcdef";
 while(digits){digits--;output[length++]=alphabet[(value>>(digits*4))&15];}
}
void mainCRTStartup(void) {
 HANDLE stdout_handle=GetStdHandle((DWORD)-11);
 HANDLE dc=CreateCompatibleDC(0);if(!dc)ExitProcess(3);
 unsigned char *pixels=0;
 HANDLE bitmap=CreateDIBSection(dc,&target,0,(void **)&pixels,0,0);
 if(!bitmap||!pixels)ExitProcess(4);
 HANDLE previous=SelectObject(dc,bitmap);if(!previous)ExitProcess(5);
 for(unsigned int index=0;index<sizeof(cases)/sizeof(cases[0]);index++) {
  const CASE *c=&cases[index];info.header.height=c->height;
  /* Test both implicit (0) and explicit (2) palette lengths. */
  info.header.used=(index%2)?2:0;
  for(unsigned int i=0;i<256;i++)pixels[i]=0xaa;
  int result=SetDIBitsToDevice(dc,c->dx,c->dy,c->w,c->h,c->sx,c->sy,c->start,c->lines,source,&info,0);
  output[length++]='M';output[length++]=' ';hex(index,8);output[length++]=' ';hex(result,8);
  for(unsigned int i=0;i<256;i++){output[length++]=' ';hex(pixels[i],2);}
  output[length++]='\n';DWORD written=0;
  if(!WriteFile(stdout_handle,output,length,&written,0)||written!=length)ExitProcess(2);
  length=0;
 }
 SelectObject(dc,previous);DeleteObject(bitmap);DeleteDC(dc);ExitProcess(0);
}
